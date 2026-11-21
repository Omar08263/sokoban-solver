// Push-optimal Sokoban solver, room by room.
//
// A level is a hallway with independent rooms off it: a box pushed out of a
// room into the hallway can never come back, so each room is a problem of its
// own and the level's push-optimal count is the sum of its rooms' optima.
// This program finds each room, solves it with A* over pushes (an admissible
// sum-of-distances heuristic, dead-square pruning and frozen 2x2 pruning),
// and stitches the rooms together with walks along the hallway.
//
// Deterministic by construction: the search is bounded by work (states), never
// by the clock, and every tie breaks the same way on every run, so two runs
// write the same bytes. No clock, no randomness, no network, no files outside
// /input, /output and /bot.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** States one room search keeps before it gives up: work, never the clock. */
const MAX_STATES = 250_000;
/** Second chance for a room whose first search gives up. */
const MAX_STATES_RETRY = 1_000_000;

const DIRS: [number, number, string][] = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

type Level = { w: number; h: number; wall: Uint8Array; goals: number[]; boxes: number[]; player: number };

/** A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The squares a box can stand on and still be pushed onto some goal, found by
 * pulling backwards from the goals: a square y is live when a box there can be
 * pushed one step toward a live square x (the player standing behind it).
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (y < 0 || y >= wall.length) continue;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The level's rooms: cut the hallway's dead squares (the player's row, where a
 * box reaches no goal) out of the floor; each remaining part holding boxes is
 * a room, with its door (the square touching the hallway) and the hallway
 * square outside it. Null when the level is no set of rooms.
 */
type Room = { squares: number[]; boxes: number[]; goals: number[]; door: number; outside: number };

function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], door: -1, outside: -1 });
  }
  for (const b of boxes) {
    if (part[b] < 0) return null;
    rooms[part[b]]!.boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  const out = rooms.filter((r) => r.boxes.length > 0);
  for (const r of out) {
    for (const s of r.squares) {
      for (const [dx, dy] of DIRS) {
        const q = s + dy * w + dx;
        if (q >= 0 && q < wall.length && cut[q]) {
          r.door = s;
          r.outside = q;
          break;
        }
      }
      if (r.door >= 0) break;
    }
    if (r.door < 0) return null;
  }
  return out;
}

/** The squares the player reaches from `from` around walls and boxes; returns the lowest square of the region. */
function reach(
  w: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes with a box off its goal. */
function frozenBlock(w: number, wall: Uint8Array, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (u first on ties). */
function walkTo(w: number, wall: Uint8Array, boxes: number[], from: number, to: number): string {
  if (from === to) return '';
  const occupied = new Uint8Array(wall.length);
  for (const b of boxes) occupied[b] = 1;
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: target out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/**
 * The push-optimal solution of `level` (or null when the search gives up):
 * A* over pushes. A state is its boxes and the player's reachable region
 * (keyed by the region's lowest square, so equal positions collapse). The
 * estimate is each box's floor distance to its nearest goal, summed — every
 * push moves one box one square, so it never overestimates. Boxes on dead
 * squares and frozen 2x2 blocks are pruned; neither prunes a solvable state.
 * `exit` is the square the player must be able to reach once every box is on
 * a goal (the hallway square outside a room's door), or null for a whole-level
 * search where only the boxes matter.
 */
function solvePushAStar(level: Level, exit: number | null, maxStates: number): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  // Each square's floor distance to its nearest goal (multi-source BFS).
  const dist = new Int32Array(size).fill(-1);
  const dq: number[] = [...goals];
  for (const g of goals) dist[g] = 0;
  for (let qi = 0; qi < dq.length; qi++) {
    const p = dq[qi]!;
    for (const [dx, dy] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= size) continue;
      if (!wall[q] && dist[q] < 0) {
        dist[q] = dist[p]! + 1;
        dq.push(q);
      }
    }
  }
  const est = (bs: number[]): number => bs.reduce((a, b) => a + dist[b]!, 0);

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const keyOf = (bs: number[], low: number): number => {
    let k = low;
    for (const b of bs) k = k * size + b;
    return k;
  };
  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);

  // The states: boxes, player square, pushes so far, parent, and the push that made them.
  const sBoxes: number[][] = [level.boxes.slice()];
  const sPlayer: number[] = [level.player];
  const sG: number[] = [0];
  const sH: number[] = [est(level.boxes)];
  const sParent: number[] = [-1];
  const sPushBox: number[] = [-1];
  const sPushDir: number[] = [-1];
  const closed = new Map<number, number>();
  for (const b of level.boxes) occupied[b] = 1;
  closed.set(keyOf(level.boxes, reach(w, wall, occupied, level.player, seen, ++stamp, stack)), 0);
  for (const b of level.boxes) occupied[b] = 0;

  // A binary heap on (f, h, insertion order): the same order on every run.
  const heap: [number, number, number, number][] = [[sH[0]!, sH[0]!, 0, 0]];
  let seq = 1;
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  let found = -1;
  while (heap.length > 0) {
    const [, , , s] = heapPop();
    const boxes = sBoxes[s]!;
    const g = sG[s]!;
    for (const b of boxes) occupied[b] = 1;
    const regionStamp = ++stamp;
    reach(w, wall, occupied, sPlayer[s]!, seen, regionStamp, stack);
    if (solved(boxes) && (exit === null || seen[exit] === regionStamp)) {
      for (const x of boxes) occupied[x] = 0;
      found = s;
      break;
    }
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (let k = 0; k < 4; k++) {
        const [dx, dy] = DIRS[k]!;
        const d = dy * w + dx;
        const t = b + d;
        if (t < 0 || t >= size) continue;
        if (wall[t] || occupied[t] || !live[t]) continue;
        if (seen[b - d] !== regionStamp) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(w, wall, occupied, goal, t);
        let key = -1;
        let next: number[] | null = null;
        let nh = 0;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, reach(w, wall, occupied, b, mark, ++stamp, stack));
          nh = est(next);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null) continue;
        const prevG = closed.get(key);
        if (prevG !== undefined && prevG <= g + 1) continue;
        if (sBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        closed.set(key, g + 1);
        sBoxes.push(next);
        sPlayer.push(b);
        sG.push(g + 1);
        sH.push(nh);
        sParent.push(s);
        sPushBox.push(b);
        sPushDir.push(k);
        heapPush([g + 1 + nh, nh, seq++, sBoxes.length - 1]);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;
  // The path of pushes, then the moves: walk to each push's square, then push, then walk out.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  for (const s of path) {
    const B = sPushBox[s]!;
    const k = sPushDir[s]!;
    const [dx, dy, letter] = DIRS[k]!;
    const d = dy * w + dx;
    moves += walkTo(w, wall, boxes, player, B - d);
    moves += letter;
    player = B;
    const nb = boxes.slice();
    nb[nb.indexOf(B)] = B + d;
    nb.sort((a, b) => a - b);
    boxes = nb;
  }
  if (exit !== null) moves += walkTo(w, wall, boxes, player, exit);
  return { pushes: path.length, moves };
}

/** The player's square after `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/** The level solved room by room: each room's push-optimal solution in turn, the player walking on along the hallway. */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const rooms = roomsOf(level);
  if (rooms === null) {
    const r = solvePushAStar(level, null, MAX_STATES) ?? solvePushAStar(level, null, MAX_STATES_RETRY);
    return r === null ? '' : r.moves;
  }
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    // Walk along the hallway to the square outside this room's door.
    const hw = level.w;
    const fromX = player % hw;
    const toX = room.outside % hw;
    if (fromX !== toX) {
      const step = toX > fromX ? 'r' : 'l';
      const n = Math.abs(toX - fromX);
      let ok = true;
      for (let x = 1; x <= n; x++) {
        const q = player + (toX > fromX ? x : -x);
        if (level.wall[q]) {
          ok = false;
          break;
        }
      }
      if (!ok) return '';
      moves += step.repeat(n);
      player = room.outside;
    }
    // The room on its own: its squares plus the hallway square outside its door.
    const subWall = new Uint8Array(level.wall.length).fill(1);
    for (const s of room.squares) subWall[s] = 0;
    subWall[room.outside] = 0;
    const sub: Level = { w: level.w, h: level.h, wall: subWall, goals: room.goals.slice(), boxes: room.boxes.slice(), player: room.outside };
    const solved = solvePushAStar(sub, room.outside, MAX_STATES) ?? solvePushAStar(sub, room.outside, MAX_STATES_RETRY);
    if (solved === null) return '';
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
