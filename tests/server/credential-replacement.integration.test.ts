/**
 * B-R6 — a credential the keychain could not store must never become the player.
 *
 * The final Refresh-B audit (September 29, 2026) saved unlinked player A on a
 * device, then made the platform keychain refuse writes during a REAL password
 * sign-in to player B. Sign-in reported success and the app showed **B** — while
 * a fresh `getSession()` returned **A**, and a friend request sent from that
 * screen landed in the database with **A as the sender**. GoTrue keeps no
 * session in memory: every request reads the credential back from storage, and
 * storage still held A. The adapter had swallowed the failed write, and GoTrue
 * announced SIGNED_IN(B) the moment `setItem` returned.
 *
 * This is that reproduction, kept and inverted, through production code end to
 * end: the production chunked keychain adapter (only the native keychain beneath
 * it is a double, so writes can be made to fail), `@supabase/supabase-js` with
 * the options `src/lib/supabase/client.ts` sets (PKCE, `processLock`), real
 * GoTrue, the production Auth store — hydrated through its own `hydrate()`, so
 * adoption runs through its own listener — the production adapter, and the
 * production friends store and gateway for the protected request. Readbacks come
 * from the database. Nothing about a credential, a session or a verdict is
 * fabricated.
 *
 * Beside the reproduction: a relaunch, the positive control (a replacement the
 * keychain DOES store switches everything together), the same player's token
 * rotation (which must still degrade rather than refuse), the password-recovery
 * exchange (the same swallowed write reached `updateUser`, which reads the
 * credential back from storage — so a recovery could set the new password on
 * the PREVIOUS player's account), and the first creation of a player on a
 * device that cannot store one.
 *
 * A SKIP IS NOT A PASS. `npm run test:server` sets ARC21_REQUIRE_SERVER_STACK.
 */

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, processLock } from "@supabase/supabase-js";

import { stackUp } from "./stack-guard.js";
import {
  disposeAuthSubscription,
  setGuestIdentityStore,
  useAuthStore,
} from "../../src/features/auth/auth-store.js";
import { initialAuthFormState } from "../../src/features/auth/auth-machine.js";
import { GuestIdentityStore } from "../../src/features/auth/guest.js";
import { MemoryKeyValueStore } from "../../src/lib/persistence/key-value-store.js";
import { resetPlayerState } from "../../src/features/player/reset-player-state.js";
import { useFriendsStore } from "../../src/features/friends/friends-store.js";
import {
  setSupabaseAvailabilityForTests,
  type ArcSupabaseClient,
} from "../../src/lib/supabase/client.js";
import {
  ChunkedSecureSessionStorage,
  type SecureStoreLike,
  type SessionStorageDurability,
} from "../../src/lib/supabase/secure-session-storage.js";

const URL = "http://127.0.0.1:54321";
const MAILPIT = "http://127.0.0.1:54324";
// Published local-only test keys, identical to the existing integration suites.
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const ADMIN_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

/** The SDK's default key for this project URL, `sb-<first host label>-auth-token`. */
const SESSION_KEY = "sb-127-auth-token";

const admin = createClient(URL, ADMIN_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

/**
 * The platform keychain, and nothing else, is the double: reads always work and
 * writes fail on demand — the audit's injection. Everything above it is the
 * production `ChunkedSecureSessionStorage`.
 */
interface Keychain extends SecureStoreLike {
  readonly entries: Map<string, string>;
  failWrites: boolean;
}

function keychain(): Keychain {
  const entries = new Map<string, string>();
  const chain: Keychain = {
    entries,
    failWrites: false,
    async getItemAsync(key) {
      return entries.get(key) ?? null;
    },
    async setItemAsync(key, value) {
      if (chain.failWrites) throw new Error("injected keychain write failure");
      entries.set(key, value);
    },
    async deleteItemAsync(key) {
      entries.delete(key);
    },
  };
  return chain;
}

/** Every durability report for the session key, in order — the UI's warning seam. */
const durability: SessionStorageDurability[] = [];

/**
 * A device: `src/lib/supabase/client.ts`'s auth options over one keychain. The
 * only difference is `autoRefreshToken: false`, so no timer outlives the file.
 * `onSignup` sees the id of any player GoTrue creates, so a player the device
 * then refuses to keep can still be cleaned up.
 */
function deviceOn(chain: Keychain, onSignup?: (id: string) => void): ArcSupabaseClient {
  return createClient(URL, ANON, {
    auth: {
      storage: new ChunkedSecureSessionStorage(chain, {}, (key, status) => {
        if (key.endsWith("-auth-token")) durability.push(status);
      }),
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: "pkce",
      lock: processLock,
    },
    global: {
      fetch: async (input: RequestInfo | globalThis.URL, init?: RequestInit) => {
        const response = await fetch(input, init);
        if (onSignup && String(input instanceof Request ? input.url : input).includes("/auth/v1/signup")) {
          const body = (await response.clone().json().catch(() => null)) as { user?: { id?: string } } | null;
          if (body?.user?.id) onSignup(body.user.id);
        }
        return response;
      },
    },
  }) as ArcSupabaseClient;
}

/**
 * Whoever a cold start would restore: the player the keychain actually holds.
 * Parsed here rather than with the module's own helper, so this file measures
 * the storage instead of trusting it.
 */
async function storedPlayer(chain: Keychain): Promise<string | null> {
  const raw = await new ChunkedSecureSessionStorage(chain).getItem(SESSION_KEY);
  return raw === null ? null : ((JSON.parse(raw) as { user?: { id?: string } }).user?.id ?? null);
}

async function sdkPlayer(client: ArcSupabaseClient): Promise<string | null> {
  return (await client.auth.getSession()).data.session?.user.id ?? null;
}

const visiblePlayer = (): string | null => useAuthStore.getState().session?.account.userId ?? null;

/**
 * The app starting on `client`: the production store's own `hydrate()`, which
 * installs the production adapter's auth listener and restores (or creates)
 * the player through `ensurePlayer`.
 */
async function launchOn(client: ArcSupabaseClient): Promise<void> {
  disposeAuthSubscription();
  setSupabaseAvailabilityForTests({ status: "ready", client });
  setGuestIdentityStore(new GuestIdentityStore(new MemoryKeyValueStore()));
  useAuthStore.setState({
    hydrated: false,
    session: null,
    mode: "unknown",
    guest: null,
    form: initialAuthFormState("signIn"),
    bootstrapStatus: "idle",
    bootstrapFailure: null,
    automaticBootstrap: true,
  });
  await useAuthStore.getState().hydrate();
}

async function signInOnScreen(email: string, password: string, replacing: string | null): Promise<void> {
  useAuthStore.getState().dispatch({ type: "EDIT_EMAIL", value: email });
  await useAuthStore.getState().signIn(password, replacing);
}

/** Readbacks straight from the database; THROWS when it cannot run. */
function database(sql: string): string {
  return execFileSync(
    "docker",
    ["exec", "supabase_db_arc21", "psql", "-U", "postgres", "-d", "postgres", "-X", "-v", "ON_ERROR_STOP=1", "-Atc", sql],
    { encoding: "utf8" },
  ).trim();
}

function sendersTo(receiver: string): readonly string[] {
  return JSON.parse(
    database(
      `select coalesce(json_agg(sender_id::text order by created_at), '[]'::json)
       from public.friend_requests where receiver_id = '${receiver}'::uuid`,
    ),
  ) as string[];
}

/** An independent client proves a password by using it, not by reading a row. */
async function passwordWorks(email: string, password: string): Promise<boolean> {
  const probe = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: "pkce" },
  });
  const result = await probe.auth.signInWithPassword({ email, password });
  return result.error === null && result.data.session !== null;
}

async function createSecured(email: string, password: string): Promise<string> {
  const result = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  expect(result.error).toBeNull();
  created.push(result.data.user!.id);
  return result.data.user!.id;
}

/** The PKCE `code` a recovery email's link redirects the app with. */
async function recoveryCodeFor(address: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  let messageId: string | null = null;
  while (messageId === null && Date.now() < deadline) {
    const search = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`);
    const found = (await search.json()) as { messages: { ID: string }[] };
    if (found.messages.length > 0) messageId = found.messages[0]!.ID;
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (messageId === null) throw new Error(`no recovery email arrived for ${address}`);
  const message = (await (await fetch(`${MAILPIT}/api/v1/message/${messageId}`)).json()) as { Text: string };
  const link = message.Text.match(/https?:\/\/\S*\/auth\/v1\/verify\?\S+/)?.[0];
  if (!link) throw new Error("no verify link in the recovery email");
  const verified = await fetch(link, { redirect: "manual" });
  const location = verified.headers.get("location");
  if (!location) throw new Error(`the verify link did not redirect (${verified.status})`);
  const code = new globalThis.URL(location.replace("arc21://", "https://arc21.invalid/")).searchParams.get("code");
  if (!code) throw new Error("the recovery redirect carried no code");
  return code;
}

const created: string[] = [];
const chainOne = keychain();
let device = deviceOn(chainOne);
let playerA = "";
let playerB = "";
let recipient = "";
const emailB = `b-r6-${randomUUID()}@arc21.test`;
const passwordB = `Replace-${randomUUID()}!`;
let stopIdentity: (() => void) | null = null;

const suite = stackUp ? describe : describe.skip;

suite("B-R6: a player whose credential could not be stored is never adopted", () => {
  beforeAll(async () => {
    // A: an unlinked player, saved normally on this device — the audit's A.
    const a = await device.auth.signInAnonymously();
    expect(a.error).toBeNull();
    playerA = a.data.user!.id;
    created.push(playerA);
    expect(chainOne.entries.has(SESSION_KEY)).toBe(true);

    playerB = await createSecured(emailB, passwordB);
    recipient = await createSecured(`b-r6-recipient-${randomUUID()}@arc21.test`, `Recipient-${randomUUID()}!`);

    await launchOn(device);
    expect(visiblePlayer()).toBe(playerA);

    // `usePlayerState`'s identity-change body; the hook itself needs React Native.
    stopIdentity = useAuthStore.subscribe((next, previous) => {
      if ((next.session?.account.userId ?? null) !== (previous.session?.account.userId ?? null)) resetPlayerState();
    });
  });

  afterAll(async () => {
    stopIdentity?.();
    disposeAuthSubscription();
    resetPlayerState();
    useAuthStore.setState({ session: null, mode: "guest" });
    setGuestIdentityStore(null);
    setSupabaseAvailabilityForTests(null);
    for (const id of created) {
      const result = await admin.auth.admin.deleteUser(id);
      expect(result.error).toBeNull();
    }
  });

  it("refuses the sign-in, and the screen and every request stay with player A", async () => {
    chainOne.failWrites = true;
    await signInOnScreen(emailB, passwordB, playerA);

    expect(useAuthStore.getState().form.status).toMatchObject({
      kind: "failed",
      failure: { code: "PERSISTENCE_UNAVAILABLE" },
    });
    /*
     * THE ASSERTIONS THE AUDIT FAILED ON. It read `shown: B`, `actual: A`. The
     * only consistent answer is A in all three places: the player on screen,
     * the credential the SDK will attach, and the player a relaunch restores.
     */
    expect(visiblePlayer()).toBe(playerA);
    expect(await sdkPlayer(device)).toBe(playerA);
    expect(await storedPlayer(chainOne)).toBe(playerA);
    // The durability warning still says what happened.
    expect(durability.at(-1)).toBe("unavailable");

    // A protected request from the state the app is now in: it is sent as the
    // player the screen shows, which is the whole invariant.
    expect(await useFriendsStore.getState().sendRequest(recipient)).toBe(true);
    expect(sendersTo(recipient)).toEqual([playerA]);
    expect(sendersTo(recipient)).toEqual([visiblePlayer()]);
  });

  it("restores the same player A on relaunch, while the keychain still cannot write", async () => {
    device = deviceOn(chainOne);
    await launchOn(device);
    expect(visiblePlayer()).toBe(playerA);
    expect(await sdkPlayer(device)).toBe(playerA);
  });

  it("switches the screen, the requests and the keychain to B together once B is stored", async () => {
    // The positive control: the same sign-in, with a keychain that works.
    chainOne.failWrites = false;
    await signInOnScreen(emailB, passwordB, playerA);

    expect(useAuthStore.getState().form.status.kind).toBe("signedIn");
    expect(visiblePlayer()).toBe(playerB);
    expect(await sdkPlayer(device)).toBe(playerB);
    expect(await storedPlayer(chainOne)).toBe(playerB);
    expect(durability.at(-1)).toBe("durable");

    expect(await useFriendsStore.getState().sendRequest(recipient)).toBe(true);
    expect(sendersTo(recipient)).toEqual([playerA, playerB]);

    device = deviceOn(chainOne);
    await launchOn(device);
    expect(visiblePlayer()).toBe(playerB);
  });

  it("still rotates the same player's token, and degrades rather than refusing when the keychain cannot store it", async () => {
    // Working keychain: the rotated session is the one stored.
    const rotated = await device.auth.refreshSession();
    expect(rotated.error).toBeNull();
    expect(rotated.data.session?.user.id).toBe(playerB);
    const stored = JSON.parse((await new ChunkedSecureSessionStorage(chainOne).getItem(SESSION_KEY))!) as {
      refresh_token: string;
    };
    expect(stored.refresh_token).toBe(rotated.data.session!.refresh_token);

    // Failing keychain, SAME player: identity cannot split, so nothing refuses.
    chainOne.failWrites = true;
    const degraded = await device.auth.refreshSession();
    expect(degraded.error).toBeNull();
    expect(degraded.data.session?.user.id).toBe(playerB);
    expect(visiblePlayer()).toBe(playerB);
    expect(await sdkPlayer(device)).toBe(playerB);
    expect(await storedPlayer(chainOne)).toBe(playerB);
    expect(durability.at(-1)).toBe("unavailable");
    chainOne.failWrites = false;
  });

  it("refuses a recovery the keychain cannot store before any password changes, for either player", async () => {
    // Device two holds secured player P; R's recovery link is opened on it.
    const emailP = `b-r6-prior-${randomUUID()}@arc21.test`;
    const passwordP = `Prior-${randomUUID()}!`;
    const emailR = `b-r6-recovered-${randomUUID()}@arc21.test`;
    const passwordR = `Recovered-${randomUUID()}!`;
    const newPassword = `Chosen-${randomUUID()}-Aa1`;
    const playerP = await createSecured(emailP, passwordP);
    await createSecured(emailR, passwordR);

    const chainTwo = keychain();
    const deviceTwo = deviceOn(chainTwo);
    expect((await deviceTwo.auth.signInWithPassword({ email: emailP, password: passwordP })).error).toBeNull();
    await launchOn(deviceTwo);
    expect(visiblePlayer()).toBe(playerP);

    useAuthStore.getState().dispatch({ type: "EDIT_EMAIL", value: emailR });
    await useAuthStore.getState().requestPasswordReset();
    expect(useAuthStore.getState().form.status.kind).toBe("resetLinkSent");
    const code = await recoveryCodeFor(emailR);

    chainTwo.failWrites = true;
    const failure = await useAuthStore.getState().completePasswordReset(code, newPassword, playerP);
    expect(failure).toMatchObject({ code: "PERSISTENCE_UNAVAILABLE" });
    expect(visiblePlayer()).toBe(playerP);
    expect(await sdkPlayer(deviceTwo)).toBe(playerP);
    expect(await storedPlayer(chainTwo)).toBe(playerP);

    /*
     * Proved by signing in, not by reading a row. Before the repair the SDK
     * announced R, then `updateUser` read the credential back from storage —
     * P's — and set the new password on P's account.
     */
    expect(await passwordWorks(emailP, passwordP)).toBe(true);
    expect(await passwordWorks(emailP, newPassword)).toBe(false);
    expect(await passwordWorks(emailR, passwordR)).toBe(true);
  });

  it("never shows a newly created player that the device could not store", async () => {
    const chainThree = keychain();
    chainThree.failWrites = true;
    const deviceThree = deviceOn(chainThree, (id) => created.push(id));
    await launchOn(deviceThree);

    // GoTrue did create the player; nothing on this device can ever reach it
    // again, so it must not be shown as though it could.
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().bootstrapFailure).toMatchObject({ code: "PERSISTENCE_UNAVAILABLE" });
    expect(await sdkPlayer(deviceThree)).toBeNull();
    expect(await storedPlayer(chainThree)).toBeNull();
  });
});
