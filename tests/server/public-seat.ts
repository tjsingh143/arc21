/**
 * The one way a server test gets a seat at a public table.
 *
 * WHY THIS IS A MODULE RATHER THAN THREE COPIES OF FOUR LINES. Every caller
 * used to be
 *
 *     await rpc(token, "join_matchmaking", { p_tier: "casual" });
 *     const row = one(await rpc(token, "poll_matchmaking"));
 *     return row.room_id;
 *
 * and every one of them depended on a behaviour phase 7 removed: a lone
 * player's very FIRST poll opened a table for them and answered `matched`. That
 * is what made the specification's waiting UX unreachable — nobody ever
 * observed `waiting`, so Keep Waiting / Play Solo / Cancel could not be shown —
 * and it is also why two people who both chose Casual four seconds apart never
 * met. `poll_matchmaking` now opens a table only when there is somebody to
 * share it with.
 *
 * So GETTING A PUBLIC SEAT NEEDS TWO ACCOUNTS, and that is not a test
 * inconvenience to be worked around: it is the product behaviour these files
 * are supposed to be exercising. A helper that faked it — inserting a room
 * directly, say — would prove something the app cannot do.
 *
 * A failure here THROWS, with the rows it actually saw. A helper that reads
 * something must never return a sentinel: `-1` from a wallet reader once turned
 * a harness fault into "expected 25200 to be 199" and cost three runs.
 */

/**
 * Calls a Postgres RPC as a signed-in player. Never as the service role.
 *
 * `Record<string, unknown>` rather than `unknown` for the arguments, because
 * that is what every caller's own `rpc` accepts and a wider parameter type here
 * would make each of them unassignable.
 */
export interface QueueCaller {
  (
    token: string,
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }>;
}

export type PublicTier = "casual" | "standard" | "high";

/**
 * Mints another signed-in account, for the case below.
 *
 * The caller owns account creation — each suite has its own admin helper — so
 * this is a callback rather than a copy of one.
 */
export interface PartnerFactory {
  (): Promise<string>;
}

interface QueueRow {
  status?: string;
  room_id?: string | null;
  others_waiting?: number;
}

const one = (value: unknown): QueueRow | null =>
  Array.isArray(value) ? ((value[0] ?? null) as QueueRow | null) : ((value ?? null) as QueueRow | null);

/** Three is generous: each one is a fresh player arriving at the same stakes. */
const MAX_PARTNERS = 3;

/**
 * Enrols every token and polls until all of them hold a seat.
 *
 * The polling loop is not a sleep-and-hope: allocation is synchronous inside
 * `poll_matchmaking`, and the rounds exist because the FIRST player to poll
 * while alone is told to wait. Once a second player has opened a table, the
 * first player's next poll finds it.
 *
 * WHY IT CAN NEED TO MINT A PARTNER, which looks like a crutch and is not.
 * Allocation is GLOBAL and CI runs two server files at once, so one of these
 * tokens can be absorbed into a table another suite opened — and if that seat
 * was the table's fifth, the table is full and stops being a candidate. Its
 * partner is then a genuinely lone player at that tier, and the server is right
 * to leave it waiting: that is the whole of what this phase fixed. Waiting for
 * a partner that never arrives is not something a caller can fix by retrying,
 * so one arrives. Reproduced by a full `npm run test:server`, whose failure
 * named it exactly: `only 1 of 2 players were matched at casual`, both rows
 * `waiting` with `others_waiting: 0`.
 *
 * Returns the room each token landed in, in the order they were given.
 */
export async function matchEachIntoAPublicRoom(
  rpc: QueueCaller,
  tokens: readonly string[],
  tier: PublicTier = "casual",
  newPartner: PartnerFactory | null = null,
): Promise<string[]> {
  if (tokens.length < 2 && !newPartner) {
    throw new Error(
      "matchmaking needs at least two accounts: a public table is opened only " +
        "when there is somebody to share it with, which is the behaviour under test.",
    );
  }

  const enrol = async (token: string) => {
    const enrolled = await rpc(token, "join_matchmaking", { p_tier: tier });
    if (enrolled.status !== 200) {
      throw new Error(
        `join_matchmaking(${tier}) answered ${enrolled.status}: ${JSON.stringify(enrolled.body)}`,
      );
    }
  };

  for (const token of tokens) await enrol(token);

  const rooms = new Map<string, string>();
  const partners: string[] = [];
  const seen: unknown[] = [];

  const poll = async (token: string) => {
    const polled = await rpc(token, "poll_matchmaking");
    seen.push(polled.body);
    const row = one(polled.body);
    if (row?.status === "matched" && typeof row.room_id === "string") {
      rooms.set(token, row.room_id);
    }
  };

  for (let round = 0; round < 6 && rooms.size < tokens.length; round += 1) {
    const stillLooking = [...tokens, ...partners].filter((token) => !rooms.has(token));

    // Nobody to pair with. A player alone at a tier waits, correctly, for ever.
    if (stillLooking.length < 2 && newPartner && partners.length < MAX_PARTNERS) {
      const partner = await newPartner();
      await enrol(partner);
      partners.push(partner);
      stillLooking.push(partner);
    }

    for (const token of stillLooking) await poll(token);
  }

  // The partners were only ever here to make a table; they keep their seats and
  // are left alone, exactly as a stranger at a public table would be.
  if (rooms.size < tokens.length) {
    /*
     * LEAVE BEFORE THROWING. A `waiting` enrolment lives five minutes, and
     * `poll_matchmaking` opens a table for anyone who arrives while one is
     * outstanding — so an abandoned enrolment is not inert, it is a phantom
     * player that makes the next lone caller in ANY suite get matched. CI runs
     * two server files at a time, so that lands in a different file from the
     * one that leaked it.
     */
    for (const token of [...tokens, ...partners]) {
      if (!rooms.has(token)) await rpc(token, "leave_matchmaking");
    }
    throw new Error(
      `only ${rooms.size} of ${tokens.length} players were matched at ${tier}` +
        `${partners.length ? ` (with ${partners.length} extra partner(s))` : ""}. ` +
        `Last rows: ${JSON.stringify(seen.slice(-tokens.length))}`,
    );
  }

  return tokens.map((token) => rooms.get(token) as string);
}

/**
 * The room the FIRST token was allocated, once every token holds a seat.
 *
 * NOT "the room they all share", and the difference is the point. Allocation is
 * global: a tier may already be holding a table with one seat free, in which
 * case the first caller takes it and the second opens the next one — a correct
 * outcome that a helper insisting on co-location would report as a failure.
 * Callers that genuinely need everybody at ONE table (`openPublicTable` in
 * `public-table.integration.test.ts`) check that themselves and retry with
 * fresh accounts, which converges because the seats a contended attempt bought
 * fill the table it landed at.
 */
export async function matchIntoAPublicRoom(
  rpc: QueueCaller,
  tokens: readonly string[],
  tier: PublicTier = "casual",
  newPartner: PartnerFactory | null = null,
): Promise<string> {
  const rooms = await matchEachIntoAPublicRoom(rpc, tokens, tier, newPartner);
  return rooms[0] as string;
}
