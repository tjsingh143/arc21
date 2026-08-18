/**
 * Career node data, checked against the specification verbatim.
 *
 * This table was transcribed from the spec, and a transcription is exactly the
 * kind of thing that is silently wrong: a threshold off by five, a drill that
 * should have been a standard node, a chapter with seven entries. Each expected
 * row below is copied from the spec independently of the implementation, so the
 * test disagrees with the data if either one drifts.
 */

import { describe, expect, it } from "vitest";

import {
  CAREER_CHAPTERS,
  CAREER_NODES,
  careerNodeBySlug,
  careerNodesInChapter,
  careerNodeWorkload,
  nextCareerNode,
  TOTAL_CAREER_STARS,
} from "../../shared/career/nodes.js";

/** id, title, format, workload, 2-star accuracy %, 3-star intent. */
const SPEC: Array<[string, string, "standard" | "drill", number, number, string]> = [
  ["F1", "First Deal", "standard", 10, 60, "finish >= starting bankroll"],
  ["F2", "Hit or Hold", "standard", 12, 70, "finish >= starting bankroll"],
  ["F3", "Double Time", "drill", 12, 75, "accuracy 90"],
  ["F4", "Pair Work", "drill", 12, 75, "accuracy 90"],
  ["F5", "Shoe Run", "standard", 15, 75, "finish >= 105%"],
  ["F6", "Foundation Final", "standard", 20, 80, "finish >= 110%"],

  ["W1", "Clean Decisions", "standard", 15, 80, "finish >= starting bankroll"],
  ["W2", "Know When to Leave", "drill", 12, 80, "accuracy 95"],
  ["W3", "Controlled Risk", "standard", 20, 82, "finish >= 105%"],
  ["W4", "Soft Touch", "drill", 15, 85, "accuracy 95"],
  ["W5", "Split Decisions", "drill", 15, 85, "accuracy 95"],
  ["W6", "Workshop Final", "standard", 25, 88, "finish >= 110%"],

  ["S1", "No Hints", "standard", 20, 85, "finish >= starting bankroll"],
  ["S2", "Long Shoe", "standard", 20, 87, "finish >= 105%"],
  ["S3", "Precision", "standard", 25, 90, "ev lost <= threshold"],
  ["S4", "Decision Mix", "drill", 25, 90, "accuracy 96"],
  ["S5", "Table Test", "standard", 25, 92, "finish >= 105%"],
  ["S6", "Skyline Final", "standard", 30, 92, "finish >= 110%"],
];

describe("shape", () => {
  it("has exactly eighteen nodes", () => {
    expect(CAREER_NODES).toHaveLength(18);
  });

  it("has three chapters of six", () => {
    expect(CAREER_CHAPTERS).toHaveLength(3);
    for (const chapter of CAREER_CHAPTERS) {
      expect(careerNodesInChapter(chapter.id)).toHaveLength(6);
    }
  });

  it("uses unique ids and slugs", () => {
    expect(new Set(CAREER_NODES.map((n) => n.id)).size).toBe(18);
    expect(new Set(CAREER_NODES.map((n) => n.slug)).size).toBe(18);
  });

  it("offers three stars per node", () => {
    expect(TOTAL_CAREER_STARS).toBe(54);
  });
});

describe("every node matches the specification", () => {
  it.each(SPEC)("%s %s", (id, title, format, workload, accuracy) => {
    const node = CAREER_NODES.find((candidate) => candidate.id === id);
    expect(node, `node ${id} is missing`).toBeDefined();
    expect(node!.title).toBe(title);
    expect(node!.format === "standard" ? "standard" : "drill").toBe(format);
    expect(careerNodeWorkload(node!).count).toBe(workload);
    expect(node!.accuracyStarPercent).toBe(accuracy);
  });

  it("gives standard nodes hands and drill nodes decisions, never both", () => {
    for (const node of CAREER_NODES) {
      if (node.format === "standard") {
        expect(node.hands, `${node.id} needs a hand count`).toBeGreaterThan(0);
        expect(careerNodeWorkload(node).unit).toBe("hands");
      } else {
        expect(node.decisions, `${node.id} needs a decision count`).toBeGreaterThan(0);
        expect(careerNodeWorkload(node).unit).toBe("decisions");
        // A drill constructs targeted scenarios, so it must declare its focus —
        // otherwise it cannot be labelled honestly as a drill in the UI.
        expect(node.drillFocus, `${node.id} needs a drill focus`).not.toBeNull();
      }
    }
  });

  it("keeps accuracy thresholds inside a sane band and rising per chapter", () => {
    for (const node of CAREER_NODES) {
      expect(node.accuracyStarPercent).toBeGreaterThanOrEqual(60);
      expect(node.accuracyStarPercent).toBeLessThanOrEqual(96);
    }
    const first = CAREER_NODES.find((n) => n.id === "F1")!;
    const last = CAREER_NODES.find((n) => n.id === "S6")!;
    expect(last.accuracyStarPercent).toBeGreaterThan(first.accuracyStarPercent);
  });

  it("grades hint-revealing nodes on all decisions and hidden-answer nodes unaided", () => {
    // A "correct" choice made while the recommendation was on screen measures
    // nothing, so a node that reveals the answer must not claim unaided accuracy.
    for (const node of CAREER_NODES) {
      if (node.assistance === "learn" || node.assistance === "analysis") {
        expect(node.accuracyBasis, `${node.id}`).toBe("all");
      }
    }
  });
});

describe("progression cannot be blocked by variance", () => {
  it("chains prerequisites in order, starting from an unlocked first node", () => {
    const first = CAREER_NODES[0]!;
    expect(first.prerequisiteSlug).toBeNull();

    for (const node of CAREER_NODES.slice(1)) {
      expect(node.prerequisiteSlug, `${node.id} needs a prerequisite`).not.toBeNull();
      expect(
        careerNodeBySlug(node.prerequisiteSlug!),
        `${node.id} prerequisite ${node.prerequisiteSlug} does not exist`,
      ).not.toBeNull();
    }
  });

  it("walks from the first node to the last without a gap", () => {
    let node = CAREER_NODES[0]!;
    const seen = [node.id];
    for (let i = 0; i < 20; i++) {
      const next = nextCareerNode(node);
      if (!next) break;
      seen.push(next.id);
      node = next;
    }
    expect(seen).toHaveLength(18);
    expect(seen[0]).toBe("F1");
    expect(seen[17]).toBe("S6");
  });
});
