/**
 * Emits the `public.career_nodes` catalogue from `shared/career/nodes.ts`.
 *
 * WHY THIS EXISTS. The database held a SECOND career catalogue — eighteen rows
 * with different codes, different titles, different rewards and a declarative
 * `objective` grammar (`play_hands`, `reach_chips`, `win_with_action`) that
 * nothing in this repository has ever interpreted. The app has always played
 * `CAREER_NODES`. Two catalogues is the shape invariant 7 forbids, and the one
 * the client cannot see is the one that silently decides what a cosmetic
 * unlock means.
 *
 * So the table is generated. `tests/career/catalogue-sql.test.ts` re-runs this
 * and compares the output byte for byte with the committed migration, which is
 * the same discipline `scripts/generate-audio.ts` and
 * `scripts/generate-strategy-tables.ts` are held to.
 *
 * WHAT THE ROW IS FOR. The RULES stay in `shared/career/nodes.ts`, which the
 * Edge Function imports directly — the row is not a second implementation of
 * star logic. What the row provides is the identity a database can join on: the
 * key `career_progress` points at, the chapter a cosmetic gate counts over, and
 * the reward the ledger pays. `objective` carries a faithful projection of the
 * node so the catalogue is readable in the database, generated from the same
 * source, so it cannot drift into a rival definition.
 *
 *   npm run career:generate
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CAREER_NODES } from "../shared/career/nodes.js";
import type { CareerChapterId, CareerNode } from "../shared/career/types.js";

const OUT = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "supabase/migrations/20260823120000_career_catalogue.sql",
);

/** The database's chapter enum, keyed by the shared catalogue's chapter id. */
const CHAPTER_ENUM: Record<CareerChapterId, string> = {
  foundations: "FOUNDATIONS",
  workshop: "THE_WORKSHOP",
  skyline: "SKYLINE",
};

const CHAPTER_ORDER: Record<CareerChapterId, number> = {
  foundations: 1,
  workshop: 2,
  skyline: 3,
};

/** Single-quote escaping for SQL literals. The only strings here are ours. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The node, as JSON the database can be read for.
 *
 * `ev_lost` is emitted in MILLIONTHS as an integer. Nothing in this schema
 * stores a float, and while jsonb would happily hold 0.5, a threshold written
 * one way in the database and another way in the module is exactly the drift
 * this file exists to prevent. Millionths is the unit `ev_lost_micros` already
 * uses on `daily_entries`.
 */
function objectiveOf(node: CareerNode): string {
  const mastery =
    node.mastery.kind === "finish_bankroll"
      ? { kind: "finish_bankroll", percentOfStart: node.mastery.percentOfStart }
      : node.mastery.kind === "accuracy"
        ? { kind: "accuracy", percent: node.mastery.percent }
        : { kind: "ev_lost", maxEvLostMicros: Math.round(node.mastery.maxEvLost * 1_000_000) };

  return JSON.stringify({
    // The CHECK constraint requires a `type`. It is the node's format, which is
    // the only thing about a node that changes how it is played.
    type: node.format,
    nodeId: node.id,
    hands: node.hands,
    decisions: node.decisions,
    drillFocus: node.drillFocus,
    assistance: node.assistance,
    accuracyBasis: node.accuracyBasis,
    accuracyStarPercent: node.accuracyStarPercent,
    maxWagerPercentOfStart: node.maxWagerPercentOfStart,
    mastery,
  });
}

const rows = CAREER_NODES.map((node) => {
  const requires = node.prerequisiteSlug === null ? "null" : quote(node.prerequisiteSlug);
  return `  (${quote(node.slug)}, ${quote(CHAPTER_ENUM[node.chapter])}, ${CHAPTER_ORDER[node.chapter]}, ${node.order},
   ${quote(node.title)},
   ${quote(node.summary)},
   ${quote(objectiveOf(node))},
   ${node.startingBankroll}, ${node.reward.chips}, ${node.reward.xp}, ${requires})`;
}).join(",\n\n");

const sql = `-- =============================================================================
-- Arc 21 — the career catalogue, GENERATED. Do not edit by hand.
--
-- Written by \`npm run career:generate\` from \`shared/career/nodes.ts\`, which is
-- the catalogue the application has always played.
-- \`tests/career/catalogue-sql.test.ts\` regenerates this file and compares it
-- byte for byte, so an edit here fails the suite rather than surviving as a
-- second definition.
--
-- WHAT THIS REPLACES. \`supabase/seed.sql\` held eighteen DIFFERENT nodes —
-- \`foundations-1\` "First Hand", \`workshop-3\` "Late Surrender" — with a
-- declarative \`objective\` grammar nothing has ever interpreted, while the app
-- shipped \`first-deal\`, \`hit-or-hold\` and the rest. Two catalogues, and the
-- one the player could not see was the one \`career_progress\` and every
-- career-gated cosmetic were keyed to. The stale rows are removed below rather
-- than left beside the real ones: a \`career_chapter\` cosmetic requires EVERY
-- node in its chapter to be complete, so a leftover node nobody can play would
-- make three chapter rewards permanently unobtainable.
--
-- AND WHY IT IS A MIGRATION. \`seed.sql\` runs on \`supabase db reset\` and NOT on
-- \`supabase db push\`. Catalogue data that lives only there does not exist in a
-- deployed project — and with no \`rulesets\` row, \`resolveRulesetId\` fails and
-- no session of any kind can be created. See the companion migration
-- 20260823110000.
-- =============================================================================

-- The catalogue is written by migrations, so the writer is \`postgres\` and the
-- deny-client-write trigger has nothing to say. It is dropped and rebuilt in one
-- transaction: an id is not a stable key here, the CODE is.
delete from public.career_nodes
where code not in (
${CAREER_NODES.map((node) => `  ${quote(node.slug)}`).join(",\n")}
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
${rows}
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
${CAREER_NODES.filter((node) => node.prerequisiteSlug !== null)
  .map((node) => `  (${quote(node.slug)}, ${quote(node.prerequisiteSlug!)})`)
  .join(",\n")}
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

  if (select count(*) from public.career_nodes) <> ${CAREER_NODES.length} then
    raise exception 'career catalogue is % rows, expected ${CAREER_NODES.length}',
      (select count(*) from public.career_nodes);
  end if;
end $$;
`;

writeFileSync(OUT, sql);
console.log(`wrote ${OUT} (${CAREER_NODES.length} nodes)`);
