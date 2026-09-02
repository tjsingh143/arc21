-- =============================================================================
-- Arc 21 — the two server-owned tables that had no write guard
--
-- `public.deny_client_write()` is a BEFORE trigger that raises 42501 when
-- `current_user` is `anon` or `authenticated`. Every server-owned table carries
-- it — `wallets`, `player_stats`, `player_mode_stats`, `daily_entries`,
-- `player_decision_periods`, `tournament_entries`, `tournaments`,
-- `user_cosmetics` — for a reason this repository has learned expensively:
-- SIXTEEN migrations have added a client grant without meaning to, and a table
-- whose only protection is the absence of a grant is one migration away from
-- being writable.
--
-- Two were missing it, and both are inputs to something a player would want to
-- forge:
--
--   * `player_daily_xp` — the WEEKLY XP LEADERBOARD's entire input. Measured, by
--     granting `insert` to `authenticated` and pointing the phase-9 forgery test
--     at it: PostgREST answered **HTTP 201** with `repeatable_xp: 999999` and
--     `milestone_xp: 999999` on the caller's own row. One grant, top of the
--     board.
--   * `wallet_ledger` — the append-only record every balance is reconciled
--     against. `wallets` has carried the trigger since the foundation migration
--     and the ledger beside it never did.
--
-- Nothing legitimate is affected. `apply_wallet_delta`, `record_hand_settlement`,
-- `award_milestone_xp` and `claim_recovery_grant` are all SECURITY DEFINER —
-- verified in the catalogue, not assumed — so they execute as the owner and the
-- predicate is false for them, and the Edge Functions connect as `postgres`.
-- This closes a door; it does not narrow one anybody uses.
--
-- Neither table has a client grant today. That is exactly why this is worth
-- adding now rather than after somebody notices.
-- =============================================================================

create trigger player_daily_xp_deny_client_write
  before insert or update or delete on public.player_daily_xp
  for each row execute function public.deny_client_write();

create trigger wallet_ledger_deny_client_write
  before insert or update or delete on public.wallet_ledger
  for each row execute function public.deny_client_write();

-- ---------------------------------------------------------------------------
-- And the three room tables, found by asking rather than by remembering
-- ---------------------------------------------------------------------------
--
-- The two above were found by attacking the leaderboards. Then the CATALOGUE
-- was asked which tables lack the trigger — the same move
-- `23_account_lifecycle.test.sql` makes about cascades — and it named three
-- more. A list somebody maintains stops being maintained; a question stays
-- answerable.
--
-- Every function that writes these is SECURITY DEFINER (twelve of them, checked
-- in `pg_proc.prosecdef` rather than assumed), so the predicate is false for all
-- of them and nothing legitimate changes. What it removes is the possibility
-- that a client grant added by some future migration lets a player forge a room,
-- a seat at one, or a place in the matchmaking queue.
create trigger rooms_deny_client_write
  before insert or update or delete on public.rooms
  for each row execute function public.deny_client_write();

create trigger room_members_deny_client_write
  before insert or update or delete on public.room_members
  for each row execute function public.deny_client_write();

create trigger matchmaking_queue_deny_client_write
  before insert or update or delete on public.matchmaking_queue
  for each row execute function public.deny_client_write();
