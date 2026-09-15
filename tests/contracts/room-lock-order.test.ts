/**
 * THE ROOM ROW IS LOCKED BEFORE THE ENGINE STATE, ON EVERY PATH THAT TAKES BOTH.
 *
 * A public table that keeps taking players made an old ordering reachable:
 *
 *   JOIN_PUBLIC_TABLE   locks `rooms` (`for update` on the id it was given),
 *                       then the engine state, then the wallet
 *   CASH_OUT            locked the engine state, then the wallet, and reached
 *                       `rooms` only at the end, inside `release_room_seat`
 *
 * One player leaving as another sits down is an ordinary event at a live public
 * table, so Postgres picked a victim and aborted it. Nothing was corrupted and
 * no chips moved — the loser was simply answered HTTP 500 "Something went
 * wrong" for an ordinary leave. Reproduced deliberately by removing the lock
 * again: three runs out of three.
 *
 * WHY A SOURCE SCAN AND NOT ONLY THE INTEGRATION TEST. The integration test
 * (`public-table.integration.test.ts > keeps the table coherent when a leave
 * races a join`) does fail when the fix is reverted, and that is the proof the
 * fix works. What it cannot do is notice a SIXTH function acquiring both locks
 * in the wrong order next year — a deadlock only appears under a race nobody
 * thought to write. So the allowlist below is the control: a new path that
 * touches a room row fails this file until somebody has decided where its lock
 * goes. The empty-by-design `SERVER_ONLY` list in
 * `every-command-has-a-caller.test.ts` is the same idea.
 *
 * `supabase/functions` is excluded from `tsconfig.json`, so nothing else reads
 * these two files at all except `deno check`.
 */

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const FILES = [
  "supabase/functions/create-session/index.ts",
  "supabase/functions/game-command/index.ts",
] as const;

/**
 * Every function that may touch a room row, and why it is allowed to.
 *
 * Adding a name here is a decision about lock order, which is why it is a
 * literal list and not a pattern.
 */
const MAY_TOUCH_A_ROOM: Record<string, string> = {
  startPrivateTable:
    "locks the room by id `for update` before it inserts any engine state",
  joinPublicTable: "locks the room by id `for update` before `lockEngineState`",
  cashOut: "calls `lockRoomForSession` before `lockEngineState`",
  handle:
    "game-command: calls `lockRoomForSession` for LEAVE, the only command that ends at a room",
  closeCompetition:
    "tournament, daily and career sessions have no room, so the update matches no row and takes no lock",
};

/** A statement that reads, locks or writes a room row. */
const TOUCHES_A_ROOM =
  /public\.rooms|closeRoomForSession\(|releaseRoomSeat\(|lockRoomForSession\(/;

interface Block {
  readonly file: string;
  readonly name: string;
  readonly body: string;
}

/**
 * Top-level function declarations, in source order.
 *
 * Both files declare every helper as `async function name(` at column zero, so
 * the next declaration is the end of the previous body. Crude, and checked: the
 * test below asserts the split found the functions it is supposed to reason
 * about, so a refactor to arrow constants fails here rather than silently
 * scanning nothing — the `grep $DIRS` lesson.
 */
function blocksOf(file: string): Block[] {
  const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
  const starts: { name: string; at: number }[] = [];
  const declaration = /^(?:async )?function ([A-Za-z0-9_]+)\(/gm;
  for (let m = declaration.exec(source); m; m = declaration.exec(source)) {
    starts.push({ name: m[1] as string, at: m.index });
  }
  return starts.map((start, index) => ({
    file,
    name: start.name,
    body: source.slice(start.at, starts[index + 1]?.at ?? source.length),
  }));
}

const ALL = FILES.flatMap(blocksOf);

describe("the room lock is taken before the engine lock", () => {
  it("found the functions to reason about", () => {
    // Guards the parser itself. A scan that matches nothing reports clean.
    expect(ALL.length).toBeGreaterThan(20);
    for (const name of Object.keys(MAY_TOUCH_A_ROOM)) {
      expect(ALL.map((block) => block.name)).toContain(name);
    }
  });

  it("names every function that touches a room row", () => {
    const touching = ALL.filter((block) => TOUCHES_A_ROOM.test(block.body))
      .map((block) => block.name)
      .sort();
    expect([...new Set(touching)]).toEqual(Object.keys(MAY_TOUCH_A_ROOM).sort());
  });

  it("takes the room first wherever it takes both", () => {
    for (const block of ALL) {
      const room = block.body.search(
        /lockRoomForSession\(|from public\.rooms\b|from\s+public\.rooms/,
      );
      const engine = block.body.indexOf("lockEngineState(");
      if (room === -1 || engine === -1) continue;
      expect(
        room,
        `${block.file} > ${block.name} locks the engine state before the room row, ` +
          "which is the inversion that deadlocked a leave against a join",
      ).toBeLessThan(engine);
    }
  });

  it("mutates a room only from a function that holds its lock", () => {
    for (const block of ALL) {
      const mutates = /closeRoomForSession\(|releaseRoomSeat\(|update public\.rooms/.test(
        block.body,
      );
      if (!mutates) continue;
      expect(
        MAY_TOUCH_A_ROOM[block.name],
        `${block.file} > ${block.name} writes a room row and is not accounted for`,
      ).toBeTruthy();
    }
  });
});
