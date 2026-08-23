-- =============================================================================
-- Arc 21 — Quick Play's assistance mode, recorded by the server
-- =============================================================================
--
-- The specification's Quick Play screen carries an assistance selector — PLAY,
-- LEARN, ANALYSIS, CHALLENGE — and LEARN puts the recommended play on screen
-- BEFORE the choice. The same specification excludes "modes where answer was
-- shown before choice" from the qualified strategy-accuracy board. `solo` is on
-- that board, so both statements can only hold if the server knows which
-- assistance the session is running.
--
-- WHY IT IS A COLUMN AND NOT A REQUEST FIELD PER DECISION. A client that could
-- name its assistance per action could opt a MISTAKE out of the count by
-- claiming it had help, and opt a good decision in by claiming it did not. The
-- choice is made once, at OPEN, and the server records it; every decision in
-- that session is then judged against a fact the client cannot revise.
--
-- It also decides whether the server SENDS the recommendation at all. The
-- advice a Learn table shows is computed server-side from authoritative state
-- and attached to the snapshot — there is one advisor in this system and it is
-- the one that grades. A client that reconstructed advice locally would be a
-- second implementation of the chart.
--
-- Default 'play': every existing session, and every mode that has no selector
-- (public tables, tournaments, the daily challenge, career), is unassisted, so
-- their eligibility is exactly what it was.

do $$ begin
  create type public.assistance_mode as enum ('play', 'learn', 'analysis', 'challenge');
exception when duplicate_object then null; end $$;

alter table public.game_sessions
  add column if not exists assistance public.assistance_mode not null default 'play';

comment on column public.game_sessions.assistance is
  'How much help the table shows. Chosen once at OPEN and never revisable by a '
  'client, because it decides whether the session''s decisions count towards the '
  'strategy leaderboard. Only Quick Play offers a choice; everything else is play.';
