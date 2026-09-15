/**
 * The database's career catalogue is the module's, or the build fails.
 *
 * There were TWO career catalogues in this repository. `shared/career/nodes.ts`
 * held the eighteen nodes the app has always played — "First Deal", ten hands,
 * 60% for the accuracy star. `supabase/seed.sql` held eighteen DIFFERENT ones —
 * "First Hand", five hands, `{"type": "play_hands", "count": 5}` — in a
 * declarative grammar nothing has ever interpreted. The player could only see
 * the first; `career_progress` and every career-gated cosmetic were keyed to
 * the second.
 *
 * So the migration is generated, and this re-runs the generator and compares.
 * The same discipline `tests/audio` holds the sound palette to: a file that
 * COULD be edited by hand is a file that will be, and the copy nobody looks at
 * is the one that decides what a reward means.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CAREER_NODES } from "../../shared/career/nodes.js";

const MIGRATION = "supabase/migrations/20260823120000_career_catalogue.sql";
const SEED = "supabase/seed.sql";

describe("the generated career catalogue", () => {
  it("is byte-for-byte what the generator emits from shared/career/nodes.ts", () => {
    // `--stdout`, never the writing form. A test that regenerates the file is a
    // test that MUTATES a tracked file while the suite reads it — which showed
    // up once as an unexplained failure in an otherwise green run.
    const generated = execFileSync(
      "npx",
      ["tsx", "scripts/generate-career-nodes.ts", "--stdout"],
      { encoding: "utf8" },
    );
    expect(readFileSync(MIGRATION, "utf8")).toBe(generated);
  }, 120_000);

  it("names every node exactly once, in the module's own order", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    for (const node of CAREER_NODES) {
      expect(sql.includes(`'${node.slug}'`)).toBe(true);
    }
    const positions = CAREER_NODES.map((node) => sql.indexOf(`  ('${node.slug}',`));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("carries each node's reward, so the ledger pays what the screen promised", () => {
    // The one genuinely duplicated fact: the reward is a column the ledger row
    // is keyed to AND a field the node detail screen renders. Asserted equal
    // rather than assumed, which is the rule CLAUDE.md sets for exactly this.
    const sql = readFileSync(MIGRATION, "utf8");
    for (const node of CAREER_NODES) {
      const row = sql.slice(sql.indexOf(`  ('${node.slug}',`));
      // The last node has no blank line after it; stop at the closing paren
      // either way rather than at a separator only the earlier rows have.
      const line = row.slice(0, row.indexOf(")\n") + 1);
      expect(line).toContain(`${node.startingBankroll}, ${node.reward.chips}, ${node.reward.xp}`);
    }
  });

  it("gates the three chapter-final cosmetics on codes the catalogue contains", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    for (const slug of ["foundation-final", "workshop-final", "skyline-final"]) {
      expect(CAREER_NODES.some((node) => node.slug === slug)).toBe(true);
      expect(sql).toContain(`'careerNodeCode', '${slug}'`);
    }
  });
});

describe("catalogue data reaches a DEPLOYED database", () => {
  it("puts no rows in seed.sql, which `supabase db push` never runs", () => {
    /*
     * The defect this is here to stop happening again, stated plainly:
     * `seed.sql` runs on `supabase db reset` and NOT on `supabase db push`. The
     * ruleset, the cosmetics and the career map lived only there — so a
     * deployed Arc 21 would have had an EMPTY `public.rulesets`, and
     * `resolveRulesetId` raises on an empty table, which means no solo table,
     * no public table, no tournament and no daily challenge could be opened at
     * all. Every local verification passed because `db reset` had just run the
     * seed.
     *
     * A file check rather than a row count, deliberately. A row count taken
     * after `db reset` cannot tell the two sources apart, which is precisely
     * how this survived.
     */
    const seed = readFileSync(SEED, "utf8");
    const inserts = seed
      .split("\n")
      .filter((line) => /^\s*(insert|copy)\s/i.test(line) && !line.trimStart().startsWith("--"));
    expect(inserts).toEqual([]);
  });
});
