-- =============================================================================
-- Arc 21 — the career catalogue, GENERATED. Do not edit by hand.
--
-- Written by `npm run career:generate` from `shared/career/nodes.ts`, which is
-- the catalogue the application has always played.
-- `tests/career/catalogue-sql.test.ts` regenerates this file and compares it
-- byte for byte, so an edit here fails the suite rather than surviving as a
-- second definition.
--
-- WHAT THIS REPLACES. `supabase/seed.sql` held eighteen DIFFERENT nodes —
-- `foundations-1` "First Hand", `workshop-3` "Late Surrender" — with a
-- declarative `objective` grammar nothing has ever interpreted, while the app
-- shipped `first-deal`, `hit-or-hold` and the rest. Two catalogues, and the
-- one the player could not see was the one `career_progress` and every
-- career-gated cosmetic were keyed to. The stale rows are removed below rather
-- than left beside the real ones: a `career_chapter` cosmetic requires EVERY
-- node in its chapter to be complete, so a leftover node nobody can play would
-- make three chapter rewards permanently unobtainable.
--
-- AND WHY IT IS A MIGRATION. `seed.sql` runs on `supabase db reset` and NOT on
-- `supabase db push`. Catalogue data that lives only there does not exist in a
-- deployed project — and with no `rulesets` row, `resolveRulesetId` fails and
-- no session of any kind can be created. See the companion migration
-- 20260823110000.
-- =============================================================================

-- The catalogue is written by migrations, so the writer is `postgres` and the
-- deny-client-write trigger has nothing to say. It is dropped and rebuilt in one
-- transaction: an id is not a stable key here, the CODE is.
delete from public.career_nodes
where code not in (
  'first-deal',
  'hit-or-hold',
  'double-time',
  'pair-work',
  'shoe-run',
  'foundation-final',
  'clean-decisions',
  'know-when-to-leave',
  'controlled-risk',
  'soft-touch',
  'split-decisions',
  'workshop-final',
  'no-hints',
  'long-shoe',
  'precision',
  'decision-mix',
  'table-test',
  'skyline-final'
);

insert into public.career_nodes (
  code, chapter, chapter_order, node_order, title, summary,
  objective, ruleset_id, tier, starting_chips, reward_chips, reward_xp, requires_node_id
)
select
  v.code, v.chapter::public.career_chapter, v.chapter_order, v.node_order,
  v.title, v.summary, v.objective::jsonb, r.id, 'casual'::public.table_tier,
  v.starting_chips::bigint, v.reward_chips::bigint, v.reward_xp,
  null::uuid
from (values
  ('first-deal', 'FOUNDATIONS', 1, 1,
   'First Deal',
   'Ten hands with the recommended play on screen before you choose.',
   '{"type":"standard","nodeId":"F1","hands":10,"decisions":null,"drillFocus":null,"assistance":"learn","accuracyBasis":"all","accuracyStarPercent":60,"maxWagerPercentOfStart":null,"mastery":{"kind":"finish_bankroll","percentOfStart":100}}',
   2000, 200, 40, null),

  ('hit-or-hold', 'FOUNDATIONS', 1, 2,
   'Hit or Hold',
   'Twelve hands, graded after each decision instead of before it.',
   '{"type":"standard","nodeId":"F2","hands":12,"decisions":null,"drillFocus":null,"assistance":"challenge","accuracyBasis":"unaided","accuracyStarPercent":70,"maxWagerPercentOfStart":null,"mastery":{"kind":"finish_bankroll","percentOfStart":100}}',
   2000, 200, 40, 'first-deal'),

  ('double-time', 'FOUNDATIONS', 1, 3,
   'Double Time',
   'Twelve constructed scenarios where doubling is the live question.',
   '{"type":"drill","nodeId":"F3","hands":null,"decisions":12,"drillFocus":"double","assistance":"challenge","accuracyBasis":"unaided","accuracyStarPercent":75,"maxWagerPercentOfStart":null,"mastery":{"kind":"accuracy","percent":90}}',
   2000, 200, 40, 'hit-or-hold'),

  ('pair-work', 'FOUNDATIONS', 1, 4,
   'Pair Work',
   'Twelve constructed pair scenarios, split or otherwise.',
   '{"type":"drill","nodeId":"F4","hands":null,"decisions":12,"drillFocus":"pair","assistance":"challenge","accuracyBasis":"unaided","accuracyStarPercent":75,"maxWagerPercentOfStart":null,"mastery":{"kind":"accuracy","percent":90}}',
   2000, 200, 40, 'double-time'),

  ('shoe-run', 'FOUNDATIONS', 1, 5,
   'Shoe Run',
   'Fifteen hands. Hold your accuracy over a longer stretch.',
   '{"type":"standard","nodeId":"F5","hands":15,"decisions":null,"drillFocus":null,"assistance":"challenge","accuracyBasis":"unaided","accuracyStarPercent":75,"maxWagerPercentOfStart":null,"mastery":{"kind":"finish_bankroll","percentOfStart":105}}',
   2000, 200, 40, 'pair-work'),

  ('foundation-final', 'FOUNDATIONS', 1, 6,
   'Foundation Final',
   'Twenty hands, everything Foundations covered, graded as you go.',
   '{"type":"standard","nodeId":"F6","hands":20,"decisions":null,"drillFocus":null,"assistance":"challenge","accuracyBasis":"unaided","accuracyStarPercent":80,"maxWagerPercentOfStart":null,"mastery":{"kind":"finish_bankroll","percentOfStart":110}}',
   2000, 500, 100, 'shoe-run'),

  ('clean-decisions', 'THE_WORKSHOP', 2, 1,
   'Clean Decisions',
   'Fifteen hands at a higher accuracy bar than Foundations asked for.',
   '{"type":"standard","nodeId":"W1","hands":15,"decisions":null,"drillFocus":null,"assistance":"challenge","accuracyBasis":"unaided","accuracyStarPercent":80,"maxWagerPercentOfStart":null,"mastery":{"kind":"finish_bankroll","percentOfStart":100}}',
   2000, 350, 60, 'foundation-final'),

  ('know-when-to-leave', 'THE_WORKSHOP', 2, 2,
   'Know When to Leave',
   'Twelve constructed hands where late surrender is on the table.',
   '{"type":"drill","nodeId":"W2","hands":null,"decisions":12,"drillFocus":"surrender","assistance":"challenge","accuracyBasis":"unaided","accuracyStarPercent":80,"maxWagerPercentOfStart":null,"mastery":{"kind":"accuracy","percent":95}}',
   2000, 350, 60, 'clean-decisions'),

  ('controlled-risk', 'THE_WORKSHOP', 2, 3,
   'Controlled Risk',
   'Twenty hands with every wager capped at a tenth of your starting stack.',
   '{"type":"standard","nodeId":"W3","hands":20,"decisions":null,"drillFocus":null,"assistance":"challenge","accuracyBasis":"unaided","accuracyStarPercent":82,"maxWagerPercentOfStart":10,"mastery":{"kind":"finish_bankroll","percentOfStart":105}}',
   2000, 350, 60, 'know-when-to-leave'),

  ('soft-touch', 'THE_WORKSHOP', 2, 4,
   'Soft Touch',
   'Fifteen constructed soft hands, where the ace changes the answer.',
   '{"type":"drill","nodeId":"W4","hands":null,"decisions":15,"drillFocus":"soft","assistance":"challenge","accuracyBasis":"unaided","accuracyStarPercent":85,"maxWagerPercentOfStart":null,"mastery":{"kind":"accuracy","percent":95}}',
   2000, 350, 60, 'controlled-risk'),

  ('split-decisions', 'THE_WORKSHOP', 2, 5,
   'Split Decisions',
   'Fifteen constructed pairs. Splitting is legal far more often than it is right.',
   '{"type":"drill","nodeId":"W5","hands":null,"decisions":15,"drillFocus":"split","assistance":"challenge","accuracyBasis":"unaided","accuracyStarPercent":85,"maxWagerPercentOfStart":null,"mastery":{"kind":"accuracy","percent":95}}',
   2000, 350, 60, 'soft-touch'),

  ('workshop-final', 'THE_WORKSHOP', 2, 6,
   'Workshop Final',
   'Twenty-five hands drawing on everything the Workshop covered.',
   '{"type":"standard","nodeId":"W6","hands":25,"decisions":null,"drillFocus":null,"assistance":"challenge","accuracyBasis":"unaided","accuracyStarPercent":88,"maxWagerPercentOfStart":null,"mastery":{"kind":"finish_bankroll","percentOfStart":110}}',
   2000, 800, 150, 'split-decisions'),

  ('no-hints', 'SKYLINE', 3, 1,
   'No Hints',
   'Twenty hands with nothing on screen. Every decision is reviewed afterwards.',
   '{"type":"standard","nodeId":"S1","hands":20,"decisions":null,"drillFocus":null,"assistance":"play","accuracyBasis":"unaided","accuracyStarPercent":85,"maxWagerPercentOfStart":null,"mastery":{"kind":"finish_bankroll","percentOfStart":100}}',
   2000, 500, 80, 'workshop-final'),

  ('long-shoe', 'SKYLINE', 3, 2,
   'Long Shoe',
   'Twenty hands unaided, at a bar that leaves little room for drift.',
   '{"type":"standard","nodeId":"S2","hands":20,"decisions":null,"drillFocus":null,"assistance":"play","accuracyBasis":"unaided","accuracyStarPercent":87,"maxWagerPercentOfStart":null,"mastery":{"kind":"finish_bankroll","percentOfStart":105}}',
   2000, 500, 80, 'no-hints'),

  ('precision', 'SKYLINE', 3, 3,
   'Precision',
   'Twenty-five hands measured by what your mistakes cost, not by what you won.',
   '{"type":"standard","nodeId":"S3","hands":25,"decisions":null,"drillFocus":null,"assistance":"play","accuracyBasis":"unaided","accuracyStarPercent":90,"maxWagerPercentOfStart":null,"mastery":{"kind":"ev_lost","maxEvLostMicros":500000}}',
   2000, 500, 80, 'long-shoe'),

  ('decision-mix', 'SKYLINE', 3, 4,
   'Decision Mix',
   'Twenty-five constructed scenarios drawn from every decision family at once.',
   '{"type":"drill","nodeId":"S4","hands":null,"decisions":25,"drillFocus":"mixed","assistance":"challenge","accuracyBasis":"unaided","accuracyStarPercent":90,"maxWagerPercentOfStart":null,"mastery":{"kind":"accuracy","percent":96}}',
   2000, 500, 80, 'precision'),

  ('table-test', 'SKYLINE', 3, 5,
   'Table Test',
   'Twenty-five hands unaided. Accuracy is read back to you at the end.',
   '{"type":"standard","nodeId":"S5","hands":25,"decisions":null,"drillFocus":null,"assistance":"play","accuracyBasis":"unaided","accuracyStarPercent":92,"maxWagerPercentOfStart":null,"mastery":{"kind":"finish_bankroll","percentOfStart":105}}',
   2000, 500, 80, 'decision-mix'),

  ('skyline-final', 'SKYLINE', 3, 6,
   'Skyline Final',
   'Thirty hands unaided. The last node of the MVP career.',
   '{"type":"standard","nodeId":"S6","hands":30,"decisions":null,"drillFocus":null,"assistance":"play","accuracyBasis":"unaided","accuracyStarPercent":92,"maxWagerPercentOfStart":null,"mastery":{"kind":"finish_bankroll","percentOfStart":110}}',
   2000, 1200, 250, 'table-test')
) as v (code, chapter, chapter_order, node_order, title, summary, objective,
        starting_chips, reward_chips, reward_xp, requires_code)
cross join lateral (
  select id from public.rulesets where key = 'arc-standard' and version = 1
) r
on conflict (code) do update set
  chapter        = excluded.chapter,
  chapter_order  = excluded.chapter_order,
  node_order     = excluded.node_order,
  title          = excluded.title,
  summary        = excluded.summary,
  objective      = excluded.objective,
  ruleset_id     = excluded.ruleset_id,
  tier           = excluded.tier,
  starting_chips = excluded.starting_chips,
  reward_chips   = excluded.reward_chips,
  reward_xp      = excluded.reward_xp;

-- The prerequisite chain, resolved by code in a second pass because a node's
-- predecessor may be inserted after it in a single statement.
update public.career_nodes n
set requires_node_id = p.id
from (values
  ('hit-or-hold', 'first-deal'),
  ('double-time', 'hit-or-hold'),
  ('pair-work', 'double-time'),
  ('shoe-run', 'pair-work'),
  ('foundation-final', 'shoe-run'),
  ('clean-decisions', 'foundation-final'),
  ('know-when-to-leave', 'clean-decisions'),
  ('controlled-risk', 'know-when-to-leave'),
  ('soft-touch', 'controlled-risk'),
  ('split-decisions', 'soft-touch'),
  ('workshop-final', 'split-decisions'),
  ('no-hints', 'workshop-final'),
  ('long-shoe', 'no-hints'),
  ('precision', 'long-shoe'),
  ('decision-mix', 'precision'),
  ('table-test', 'decision-mix'),
  ('skyline-final', 'table-test')
) as v (code, requires_code)
join public.career_nodes p on p.code = v.requires_code
where n.code = v.code;

-- Every career-gated cosmetic points at a code in the catalogue above. The
-- three chapter finals changed name with the catalogue, and a gate pointing at
-- a code that no longer exists is a reward nobody can ever earn.
update public.cosmetics set unlock_config = jsonb_build_object('careerNodeCode', 'foundation-final')
where unlock_type = 'career_node' and unlock_config ->> 'careerNodeCode' = 'foundations-6';
update public.cosmetics set unlock_config = jsonb_build_object('careerNodeCode', 'workshop-final')
where unlock_type = 'career_node' and unlock_config ->> 'careerNodeCode' = 'workshop-6';
update public.cosmetics set unlock_config = jsonb_build_object('careerNodeCode', 'skyline-final')
where unlock_type = 'career_node' and unlock_config ->> 'careerNodeCode' = 'skyline-6';

-- The chapter finales award the card back that marks them. Moved here from the
-- seed with the rest of the catalogue, and repointed at the real node codes.
update public.career_nodes n
set reward_cosmetic_id = c.id
from public.cosmetics c
where (n.code, c.code) in (
  ('foundation-final', 'back-drafting'),
  ('workshop-final',   'back-blueprint'),
  ('skyline-final',    'back-meridian')
)
and n.reward_cosmetic_id is distinct from c.id;

do $$
declare
  v_orphans text;
begin
  select string_agg(c.code, ', ') into v_orphans
  from public.cosmetics c
  where c.unlock_type = 'career_node'
    and not exists (
      select 1 from public.career_nodes n
      where n.code = c.unlock_config ->> 'careerNodeCode'
    );
  if v_orphans is not null then
    raise exception 'cosmetic(s) gated on a career node that does not exist: %', v_orphans;
  end if;

  if (select count(*) from public.career_nodes) <> 18 then
    raise exception 'career catalogue is % rows, expected 18',
      (select count(*) from public.career_nodes);
  end if;
end $$;
