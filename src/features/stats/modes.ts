/**
 * Arc 21 — the statistics mode filter.
 *
 * Four filters, but only one of them has data on this device. Practice is local
 * and client-authoritative; Quick Play and Career are server-authoritative
 * (docs/ARCHITECTURE.md) and neither exists in this build.
 *
 * The filter still ships with all four, because hiding the distinction is what
 * makes people assume local practice results count towards ranked progression.
 * Selecting a server-backed mode says so, rather than showing an empty chart
 * that reads as "you have played none of these".
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
    description: "Quick Play results are recorded on the server and need an account.",
  },
  {
    id: "career",
    label: "Career",
    source: "server",
    description: "Career progress is recorded on the server and needs an account.",
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
