/*
 * Arc 21 — a Realtime topic is not a secret, so make it a permission.
 *
 * THE CHANNEL WAS OPEN, IN BOTH DIRECTIONS. `realtime.messages` has had RLS
 * enabled since the platform migrations created it, and no policy had ever been
 * written against it — which does not mean "deny", it means the channel was
 * never declared private and Realtime therefore never consulted the table at
 * all. Measured against the running stack, twice:
 *
 *   * a client holding nothing but the ANON key subscribed to
 *     `game:<uuid>` and received the table's broadcast payload in full —
 *     every seat's display name, stack and posted bet. `game_session_seats`
 *     is deliberately readable only by a participant
 *     (`game_session_seats_select_participant`); the fan-out went around it.
 *   * worse, and the reason this is not merely an eavesdropping bug: a SECOND
 *     client sent `{ type: "broadcast", event: "state", … }` to that same
 *     topic and the first client's handler received it. `subscribe()` parses
 *     whatever arrives and hands it to `applyPushedState`, which applies a
 *     payload whose `seq` is the next one it expects. So any account could
 *     push a fabricated table onto another player's screen — a client-supplied
 *     state, which is exactly what invariant 6 exists to forbid.
 *
 * The fix is the same one for both halves: the channels become PRIVATE (see
 * `realtime-broadcast.ts` and `online-table-gateway.ts`), which makes Realtime
 * consult these policies, and the policies are written so that
 *
 *   * READING a game topic requires a live seat at that game, and
 *   * WRITING is available on the presence roster and NOWHERE ELSE.
 *
 * No client may broadcast to a game topic at all. The server does it with the
 * service role, which bypasses RLS, so the only thing that can put a state on
 * the wire is the transaction that committed it.
 *
 * Note what the read policy does NOT do: it never parses the topic. Casting
 * `substring(topic from 6)` to uuid would raise on a malformed topic and take
 * the subscription down with an error rather than a refusal. Building the
 * expected topic string FROM the seat compares text to text, is total over
 * every possible topic, and cannot be tricked by a clever one.
 */

-- A player reads the table they are sitting at. `status <> 'left'` on purpose:
-- a player who has cashed out has settled, and a settled table is no longer
-- theirs to watch. That is stricter than `is_session_participant`, which is
-- why this is spelled out here rather than delegated to it.
--
-- The subquery is filtered by `game_session_seats`' own RLS as well, since a
-- policy body runs with the invoker's rights — so this is two locks, not one.
create policy arc21_game_topic_is_for_its_seated_players
on realtime.messages
for select
to authenticated
using (
  exists (
    select 1
    from public.game_session_seats s
    where s.user_id = auth.uid()
      and s.status <> 'left'
      and realtime.topic() = 'game:' || s.game_session_id::text
  )
);

-- The presence roster is one shared topic by design: everybody publishes, and
-- the client renders only the friends it already knows about. Requiring an
-- account is the honest bound on it — an anon key was enough before — and it
-- is deliberately not narrower, because a single topic cannot express "my
-- friends" without becoming a topic per person.
create policy arc21_presence_roster_needs_an_account
on realtime.messages
for select
to authenticated
using (realtime.topic() = 'presence:players');

-- The only thing a CLIENT may put on the wire is its own presence. There is no
-- insert policy for a game topic anywhere, which is what stops the injection
-- described above; the server broadcasts as the service role and is unaffected.
create policy arc21_only_presence_may_be_written_by_a_client
on realtime.messages
for insert
to authenticated
with check (realtime.topic() = 'presence:players');

-- `anon` gets no policy at all, in either direction, so an unauthenticated
-- socket can subscribe to nothing.

comment on policy arc21_game_topic_is_for_its_seated_players on realtime.messages is
  'A game broadcast is readable only by an account holding a seat at that game that it has not left.';
comment on policy arc21_presence_roster_needs_an_account on realtime.messages is
  'The shared presence roster requires a signed-in account; the client filters it to friends.';
comment on policy arc21_only_presence_may_be_written_by_a_client on realtime.messages is
  'A client may publish presence and nothing else. Game state is broadcast by the server alone.';

-- The grant surface is unchanged by this migration, but the gate is cheap and
-- the point of it is that a migration touching authorization says so.
select public.assert_client_authorization_surface();
