/**
 * Arc 21 — the statistics mode filter.
 *
 * Four filters over two kinds of record. Practice is local and
 * client-authoritative. Career keeps its STARS locally — `career-persistence.ts`
 * writes them, and the map, the node detail and Home read them with no account
 * — while its REWARDS are server-authoritative, which is the specification's
 * own split: "a Career node may be practiced offline, but any reward-bearing
 * attempt requires server authority". Quick Play is server-recorded outright.
 *
 * The filter ships with all four, because hiding the distinction is what makes
 * people assume local practice results count towards ranked progression.
 * Selecting a mode with no local record says so, rather than showing an empty
 * chart that reads as "you have played none of these".
 */

export type StatsMode = "all" | "quick" | "career" | "practice";

export type StatsModeSource =
  /** Recorded on this device. */
  | "local"
  /** Recorded by the server; requires an account. */
  | "server";

export interface StatsModeDescriptor {
  id: StatsMode;
  label: string;
  source: StatsModeSource;
  /** Screen-reader hint; also the copy shown when a mode has no local data. */
  description: string;
}

export const STATS_MODES: readonly StatsModeDescriptor[] = [
  {
    id: "all",
    label: "All",
    source: "local",
    description: "Everything recorded on this device. Today that is Practice only.",
  },
  {
    id: "quick",
    label: "Quick",
    source: "server",
    description: "Quick Play results are recorded on the server under your player identity.",
  },
  {
    id: "career",
    label: "Career",
    /*
     * LOCAL, and this was wrong for a whole phase. It read "recorded on the
     * server and needs an account" and showed nothing — but career progress is
     * persisted on THIS DEVICE by `career-persistence.ts`, and the map, the
     * node detail and Home all read it with no account at all. What needs a
     * server is the REWARD, not the record: an offline attempt keeps its stars
     * and grants no chips. Saying otherwise turned a shipped feature into an
     * apparently missing one.
     */
    source: "local",
    description: "Stars and nodes recorded on this device. Rewards need a server-run attempt.",
  },
  {
    id: "practice",
    label: "Practice",
    source: "local",
    description: "Offline practice hands played on this device.",
  },
];

export function statsMode(id: StatsMode): StatsModeDescriptor {
  return STATS_MODES.find((mode) => mode.id === id) ?? STATS_MODES[0]!;
}

/** True when the selected filter can be answered from local data alone. */
export function hasLocalData(id: StatsMode): boolean {
  return statsMode(id).source === "local";
}
