/**
 * Arc 21 — the database as the CLIENT is allowed to see it.
 *
 * This is deliberately not the output of `supabase gen types typescript`. The
 * generated file describes everything the schema contains, including tables and
 * functions no client role may touch; handing that type to the client's
 * `createClient` would make `supabase.rpc("apply_wallet_delta", …)` and
 * `supabase.from("wallets").update(…)` typecheck cleanly and fail at runtime.
 *
 * What is written here is the *authorised surface*: the rows a client may read,
 * and nothing else. Two consequences, both intentional:
 *
 *   * `Insert` and `Update` are `Record<string, never>` for every table, so a
 *     client-side write is a compile error rather than a code review finding.
 *     The database already refuses it — RLS has no write policy and a guard
 *     trigger sits underneath — but a mistake that cannot be typed is a mistake
 *     that never reaches the database to be refused.
 *   * `Functions` declares exactly one callable: `claim_recovery_grant`, which
 *     takes no arguments. `apply_wallet_delta` is deliberately absent — it is
 *     `SECURITY DEFINER`, executable by `service_role` only, and its absence
 *     here means there is no spelling of it that compiles in client code. The
 *     distinction that matters is not how many functions are listed but that
 *     none of them accepts a number of chips.
 *
 * Rows are still validated with Zod at the boundary (see `wallet.ts`). These
 * types describe what the schema promises; the Zod schemas verify what actually
 * arrived, which under this threat model is not the same question.
 *
 * When the generated types land, keep this narrowing: derive from them with
 * `Pick`, do not replace them wholesale.
 */

/** No client role may write any of these tables. */
type ReadOnly<TRow extends Record<string, unknown>> = {
  Row: TRow;
  Insert: Record<string, never>;
  Update: Record<string, never>;
  Relationships: [];
};

/**
 * Readable in full, writable in exactly the columns the schema grants.
 *
 * `profiles` was declared `ReadOnly` under the comment above, and the comment
 * was wrong about it: `20260813120100_profiles.sql` carries a column-level
 * `grant update (username, display_name, bio, avatar_url, country_code,
 * privacy)` for `authenticated`, which the live database confirms.
 *
 * That mislabelling had a consequence, not just an inaccuracy. Because every
 * write to `profiles` was a compile error, nothing ever wrote
 * `profiles.privacy` — so the Settings screen's "Statistics visibility" control
 * stored the player's choice locally and never told the server, and every
 * account stayed at the column default of `public`. The row policy that
 * enforces it, `profiles_select_visible`, was correct the whole time; it was
 * simply never given an answer.
 *
 * The narrowing this file exists for is kept, and tightened: `Update` is the
 * granted columns and nothing else, so `update({ level: 99 })` is still a
 * compile error rather than a runtime rejection. `Insert` stays closed —
 * a profile row is created by a trigger on sign-up, never by a client.
 */
type WritableColumns<
  TRow extends Record<string, unknown>,
  TColumn extends keyof TRow,
> = {
  Row: TRow;
  Insert: Record<string, never>;
  Update: Partial<Pick<TRow, TColumn>>;
  Relationships: [];
};

/** Mirrors `public.ledger_reason` in `20260813120000_foundation.sql`. */
export type LedgerReason =
  | "initial_grant"
  | "table_buy_in"
  | "table_cash_out"
  | "career_reward"
  | "tournament_entry"
  | "tournament_prize"
  | "daily_challenge_reward"
  | "level_up_reward"
  | "daily_top_up"
  | "recovery_grant"
  | "correction";

/** Mirrors `public.profile_privacy`. */
export type ProfilePrivacy = "public" | "friends" | "private";

export type WalletRow = {
  id: string;
  user_id: string;
  /**
   * Integer chips. `bigint` in Postgres; PostgREST serialises it as a JSON
   * number, which is exact for every value this game can reach. The Zod schema
   * asserts integrality on arrival so a future large value fails loudly rather
   * than rounding.
   */
  balance: number;
  lifetime_credited: number;
  lifetime_debited: number;
  version: number;
  created_at: string;
  updated_at: string;
};

export type WalletLedgerRow = {
  id: string;
  wallet_id: string;
  user_id: string;
  delta: number;
  balance_after: number;
  reason: LedgerReason;
  reference_type: string | null;
  reference_id: string | null;
  idempotency_key: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type ProfileRow = {
  id: string;
  username: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
  country_code: string | null;
  privacy: ProfilePrivacy;
  level: number;
  xp: number;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
};

export interface Database {
  public: {
    Tables: {
      wallets: ReadOnly<WalletRow>;
      wallet_ledger: ReadOnly<WalletLedgerRow>;
      profiles: WritableColumns<
        ProfileRow,
        "username" | "display_name" | "bio" | "avatar_url" | "country_code" | "privacy"
      >;
    };
    Views: Record<string, never>;
    Functions: {
      /**
       * The Recovery Grant. Takes no arguments on purpose: identity comes from
       * the session, and eligibility and the top-up are computed server-side
       * from the locked balance.
       */
      claim_recovery_grant: {
        Args: Record<string, never>;
        Returns: WalletLedgerRow;
      };
      /**
       * Account deletion. Also argument-free: the caller comes from the
       * session, so there is no spelling of this that deletes anyone else.
       */
      /**
       * Private tables. These DO take arguments, unlike the wallet functions —
       * a seat count, a code, a room id. None of them names a chip amount,
       * which is the property that matters: a private table cannot reach a
       * wallet at all.
       */
      /**
       * The friend graph. Each takes only the OTHER person's id — identity
       * comes from the session — so there is no spelling of these that acts as
       * somebody else.
       */
      search_players: { Args: { p_query: string }; Returns: unknown };
      send_friend_request: { Args: { p_to: string }; Returns: string };
      accept_friend_request: { Args: { p_from: string }; Returns: string };
      decline_friend_request: { Args: { p_from: string }; Returns: string };
      remove_friend: { Args: { p_other: string }; Returns: string };
      block_player: { Args: { p_other: string }; Returns: string };
      unblock_player: { Args: { p_other: string }; Returns: string };
      list_friends: { Args: Record<string, never>; Returns: unknown };
      list_friend_requests: { Args: Record<string, never>; Returns: unknown };
      /**
       * The caller's OWN blocks, and argument-free for the same reason the
       * others are: there is no spelling of it that reads somebody else's. It
       * never reports who blocked the caller — a block is never disclosed to
       * the person blocked, and a listing that leaked the other direction
       * would undo that everywhere else.
       */
      list_blocked: { Args: Record<string, never>; Returns: unknown };
      /**
       * Stamps the caller's own `profiles.last_seen_at`, and no argument names
       * whose. The fallback beneath ephemeral presence: `list_friends` and
       * `player_public_profile` both return that column and the app renders it
       * through `describeLastSeen`, and until this existed nothing had ever
       * written it after signup — so "last seen" was the account's creation
       * date, for ever.
       */
      touch_last_seen: { Args: Record<string, never>; Returns: string };
      /**
       * Public matchmaking. These allocate a SEAT and never a chip — the buy-in
       * is debited by the session function through `apply_wallet_delta`, which
       * is the only path that may move money.
       */
      join_matchmaking: { Args: { p_tier: string }; Returns: unknown };
      leave_matchmaking: { Args: Record<string, never>; Returns: void };
      poll_matchmaking: { Args: Record<string, never>; Returns: unknown };
      create_private_room: { Args: { p_max_seats: number }; Returns: unknown };
      join_private_room: { Args: { p_code: string }; Returns: unknown };
      get_room_state: { Args: { p_room_id: string }; Returns: unknown };
      leave_room: { Args: { p_room_id: string }; Returns: void };
      set_room_ready: { Args: { p_room_id: string; p_ready: boolean }; Returns: void };
      /**
       * The host removing somebody from the LOBBY. It returns a boolean rather
       * than raising, because every refusal — not the host, the table is
       * already playing, no such room — has to be the same answer: a non-host
       * must not learn from the difference whether the room exists.
       */
      remove_room_member: { Args: { p_room_id: string; p_user_id: string }; Returns: boolean };
      delete_own_account: {
        Args: Record<string, never>;
        Returns: void;
      };
      /**
       * The Daily Challenge. Both argument-free, and deliberately so: the date
       * is the server's UTC date, not the caller's. A client that could name a
       * date could shop for a shoe whose cards it had already seen.
       *
       * Neither returns `seed_secret`. `ensure_todays_daily_challenge` reads back
       * through `daily_challenges_public`, a projection that does not carry the
       * column, so there is no shape of this call that leaks the shoe.
       */
      ensure_todays_daily_challenge: {
        Args: Record<string, never>;
        Returns: unknown;
      };
      my_daily_entry: {
        Args: Record<string, never>;
        Returns: unknown;
      };
      /**
       * The caller's own career progress, keyed by node CODE — which is the same
       * string as `CareerNode.slug`, so the client never needs a second lookup
       * table to translate a uuid.
       *
       * Read-only, like everything else here. Starting a reward-bearing attempt
       * is an economic command and goes through the session Edge Function, where
       * the shoe, the grading and the reward commit together or not at all.
       */
      my_career_progress: {
        Args: Record<string, never>;
        Returns: unknown;
      };
      /**
       * The caller's own tournament and daily-challenge totals. Derived from
       * `auth.uid()`; returns no identifier and nothing about any other player.
       */
      /**
       * One OTHER player's profile, as this caller may see it.
       *
       * The only read in this file that names somebody else and returns their
       * numbers, so the rule it follows is worth stating here as well as in the
       * migration: identity comes back for anybody not blocked — `search_players`
       * already discloses username, display name and level, so withholding them
       * here would conceal nothing — while every NUMBER is governed by
       * `profiles.privacy`, and a block in either direction returns no row at
       * all rather than an empty one.
       */
      player_public_profile: {
        Args: { p_user_id: string };
        Returns: unknown;
      };
      my_competition_record: {
        Args: Record<string, never>;
        Returns: unknown;
      };
      /**
       * Where the caller's own live seat is — a game id, a seat id and what kind
       * of table it is. Argument-free like the wallet functions: the seat comes
       * from `auth.uid()`, so there is no spelling of this that asks about
       * anybody else. It names an address, never a stack or a card, which is why
       * it can be a plain read rather than an Edge Function.
       */
      my_active_session: {
        Args: Record<string, never>;
        Returns: unknown;
      };
      /**
       * The Sprint Tournament's read side. `sprint_format` is the configuration a
       * player sees BEFORE paying an entry fee, read from the server so it cannot
       * drift from what is enforced.
       *
       * Registration is absent from this list on purpose: it is an economic
       * command, so it goes through the session Edge Function where the fee and
       * the entry commit together or not at all.
       */
      sprint_format: {
        Args: Record<string, never>;
        Returns: unknown;
      };
      my_sprint_entry: {
        Args: Record<string, never>;
        Returns: unknown;
      };
      /**
       * Standings. Takes the tournament and derives the viewer from the session,
       * so it cannot be used to probe whether some other account is entered in
       * something — the same shape as the friend and room predicates.
       */
      /**
       * Leaderboards. Each returns a display name, an avatar asset key and a
       * number — never a user id and never an email. The projection is the
       * server's, so there is no field here a client could render by mistake.
       */
      leaderboard_weekly_xp: { Args: { p_limit?: number }; Returns: unknown };
      leaderboard_tournament_wins: { Args: { p_limit?: number }; Returns: unknown };
      leaderboard_strategy_accuracy: { Args: { p_limit?: number }; Returns: unknown };
      leaderboard_daily_challenge: { Args: { p_date?: string; p_limit?: number }; Returns: unknown };
      /** The caller's own place, derived from the same ordering the board uses. */
      my_leaderboard_position: { Args: { p_category: string }; Returns: unknown };
      /** Qualification progress, for someone not yet on the accuracy board. */
      my_strategy_accuracy_progress: { Args: Record<string, never>; Returns: unknown };
      /**
       * Cosmetics. `grant_earned_cosmetics` takes no argument, so there is no
       * spelling of it that grants an item to somebody else, and nothing it grants
       * was chosen by the caller — every branch reads progression the server can
       * see. `equip_cosmetic` works out the slot from the item's kind; the loadout
       * trigger still validates ownership for any write path.
       */
      grant_earned_cosmetics: { Args: Record<string, never>; Returns: number };
      my_inventory: { Args: Record<string, never>; Returns: unknown };
      my_loadout: { Args: Record<string, never>; Returns: unknown };
      equip_cosmetic: { Args: { p_cosmetic_id: string }; Returns: void };
      /** Level and its next threshold, derived from stored XP. */
      my_level_progress: { Args: Record<string, never>; Returns: unknown };
      /**
       * Notifications. Reading and marking read are the only verbs a client has:
       * `notify_user` is revoked from `authenticated` entirely, so there is no
       * spelling of "post myself a notification" that compiles OR executes.
       *
       * `p_kinds` on registration is what the device asks to receive. The server
       * pushes only those kinds to that token, which is what makes the Settings
       * toggles true rather than decorative.
       */
      my_notifications: { Args: { p_limit?: number }; Returns: unknown };
      unread_notification_count: { Args: Record<string, never>; Returns: number };
      mark_notifications_read: { Args: { p_ids: string[] | null }; Returns: number };
      register_push_token: {
        Args: {
          p_token: string;
          p_platform: string;
          p_device_id: string | null;
          p_kinds: string[];
        };
        Returns: void;
      };
      retire_push_token: { Args: { p_token: string }; Returns: void };
      /**
       * Inviting a friend to a private table. Takes the room and the friend and
       * derives the sender from the session; the server re-checks friendship,
       * blocks and membership, so a room code is not a licence to message
       * strangers.
       */
      invite_friend_to_room: { Args: { p_room_id: string; p_friend: string }; Returns: string };
      sprint_standings: {
        Args: { p_tournament_id: string };
        Returns: unknown;
      };
    };
    Enums: {
      ledger_reason: LedgerReason;
      profile_privacy: ProfilePrivacy;
    };
    CompositeTypes: Record<string, never>;
  };
}
