// SPDX-License-Identifier: AGPL-3.0-only
//
// The execution map's geometry and its one connector style (MP-6-3, TG-06).
// The grid is the mockup's `GEO`: every coordinate on the map is arithmetic
// over these numbers, so the cards and the lines are two readings of one grid.
// Rail is drawn for reference only (R63, no style picked): orthogonal, one
// turn in the channel, and a fan-in shares its last segment and arrowhead
// through a junction. A line is blocked while its source step is unsatisfied.

export const GEO = {
  nodeW: 208,
  nodeH: 136,
  colGap: 48,
  rowGap: 28,
  padX: 16,
  padTop: 12,
  stageH: 16,
  padBottom: 28,
} as const;

export interface MapPath {
  readonly d: string;
  readonly wait: boolean;
  /** A fan-in's leg: its arrowhead is the shared segment's. */
  readonly stub: boolean;
}

/** A placed step, as far as the lines need it. */
export interface RailStep {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly after: readonly { readonly key: string; readonly satisfied: boolean }[];
}

interface Edge {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly wait: boolean;
}

const r1 = (n: number): number => Math.round(n * 10) / 10;
const flat = (e: Edge): boolean => Math.abs(e.y1 - e.y2) < 0.5;

/** One edge per `after` entry: the source's right port to the target's left port. */
function edgesInto(to: RailStep, at: ReadonlyMap<string, RailStep>): Edge[] {
  return to.after.flatMap((one) => {
    const from = at.get(one.key);
    if (from === undefined) return [];
    const edge: Edge = {
      x1: from.x + GEO.nodeW,
      y1: from.y + GEO.nodeH / 2,
      x2: to.x,
      y2: to.y + GEO.nodeH / 2,
      wait: !one.satisfied,
    };
    return [edge];
  });
}

function single(e: Edge): MapPath {
  const mx = r1(e.x1 + GEO.colGap / 2);
  const d = flat(e)
    ? `M${r1(e.x1)} ${r1(e.y1)} H${r1(e.x2)}`
    : `M${r1(e.x1)} ${r1(e.y1)} H${mx} V${r1(e.y2)} H${r1(e.x2)}`;
  return { d, wait: e.wait, stub: false };
}

export function routeRail(steps: readonly RailStep[]): {
  readonly paths: readonly MapPath[];
  readonly joins: readonly { readonly x: number; readonly y: number }[];
} {
  const at = new Map(steps.map((step) => [step.key, step]));
  const paths: MapPath[] = [];
  const joins: { x: number; y: number }[] = [];
  for (const to of steps) {
    const set = edgesInto(to, at);
    const [e0] = set;
    if (e0 === undefined) continue;
    if (set.length === 1) {
      paths.push(single(e0));
      continue;
    }
    const mx = r1(e0.x2 - GEO.colGap / 2);
    for (const e of set) {
      const turn = flat(e) ? '' : ` V${r1(e.y2)}`;
      paths.push({ d: `M${r1(e.x1)} ${r1(e.y1)} H${mx}${turn}`, wait: e.wait, stub: true });
    }
    const wait = set.every((e) => e.wait);
    paths.push({ d: `M${mx} ${r1(e0.y2)} H${r1(e0.x2)}`, wait, stub: false });
    joins.push({ x: mx, y: r1(e0.y2) });
  }
  // A blocked line is drawn last, so a dashed one is never hidden under a solid one.
  return { paths: [...paths.filter((p) => !p.wait), ...paths.filter((p) => p.wait)], joins };
}
