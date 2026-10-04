// SPDX-License-Identifier: AGPL-3.0-only
//
// The execution map's reading (MP-6-3, DS-TASK-12 to DS-TASK-14): the bound
// plan's steps placed in columns by depth, each beside what its runs actually
// did (AW-06's planned and observed layers), and the Rail connectors between
// them. It is a derived, read-only map: nothing here is stored or edited.
//
// **An absent plan is never an empty one.** With no bound plan the map is
// `unbound` and nothing is placed; with no run and no plan it is `no-run`; a
// bound plan with no run yet draws every step as planned.
//
// **One rule for a line** (TG-06, D-38): a line is satisfied once its source
// step is, and a step is satisfied when its newest run settled completed or
// that run's gate was approved. An approved gate satisfies the lines after
// it, so they draw solid and read "After", never "Waiting on". A superseded
// run satisfies nothing, whatever gate it kept.
//
// This package imports no `core-*` package, so the shapes it reads are its
// own: the fields of `task.execution`'s graph and of `task.read`'s gates the
// map draws. The web passes the projections themselves.

import type { Tone } from './corpus.ts';
import { GEO, routeRail, type MapPath } from './execution-rail.ts';

export { GEO, type MapPath } from './execution-rail.ts';

export interface MapObserved {
  readonly condition: string;
  readonly runState: string;
  readonly whoseMove: { readonly kind: string; readonly actorId: string | null } | null;
  readonly outcome: string | null;
  readonly fault: string | null;
  readonly lease: { readonly state: string; readonly expiresAt: string } | null;
  readonly effectObserved: boolean;
  readonly heldMinor: number | null;
  readonly spentMinor: number | null;
  readonly currency: string;
}

export interface MapNode {
  readonly nodeId: string;
  readonly condition: string;
  readonly planned: { readonly key: string; readonly title: string } | null;
  readonly observed: MapObserved;
}

export interface MapGraph {
  readonly plan: 'bound' | 'unbound';
  readonly steps?: readonly {
    readonly key: string;
    readonly title: string;
    readonly after: readonly string[];
    readonly runIds: readonly string[];
  }[];
  readonly nodes: readonly MapNode[];
}

/** A run's gate, as `task.read` showed it: the exact version it binds. */
export interface MapGate {
  readonly runId: string;
  readonly state: string;
  readonly version: number;
  readonly digest: string;
}

export interface MapStep {
  readonly key: string;
  readonly title: string;
  readonly col: number;
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly state: { readonly word: string; readonly tone: Tone };
  readonly terminal: boolean;
  readonly satisfied: boolean;
  /** Each step it comes after, and whether that one is satisfied. */
  readonly after: readonly { readonly key: string; readonly satisfied: boolean }[];
  /** "Starts the plan", "After a + b" or "Waiting on a + b". */
  readonly sentence: string;
  readonly runs: readonly MapNode[];
  readonly gate: MapGate | null;
  readonly out: { readonly k: 'NEEDS' | 'WAIT' | 'STOP' | 'OUT'; readonly v: string };
}

export type ExecutionMapView =
  | { readonly kind: 'no-run' }
  | { readonly kind: 'unbound'; readonly runs: number }
  | {
      readonly kind: 'bound';
      readonly steps: readonly MapStep[];
      readonly paths: readonly MapPath[];
      readonly joins: readonly { readonly x: number; readonly y: number }[];
      readonly stages: number;
      readonly width: number;
      readonly height: number;
      readonly orphans: readonly MapNode[];
      readonly preselect: string | null;
    };

const word = (raw: string): string => {
  const text = raw.replaceAll('_', ' ').trim();
  return text === '' ? 'Unknown' : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
};

function stateOf(run: MapNode | undefined, gate: MapGate | null): { word: string; tone: Tone } {
  if (run === undefined) return { word: 'Planned', tone: 'wait' };
  const { condition, outcome, runState } = run.observed;
  if (condition === 'settled') {
    if (outcome === 'completed') return { word: 'Done', tone: 'done' };
    return { word: word(outcome ?? 'settled'), tone: outcome === 'cancelled' ? 'wait' : 'bad' };
  }
  if (condition === 'in_progress') return { word: 'In progress', tone: 'run' };
  if (condition === 'superseded') return { word: 'Superseded', tone: 'wait' };
  if (gate?.state === 'pending') return { word: 'Waiting at gate', tone: 'gate' };
  if (gate?.state === 'approved') return { word: 'Approved', tone: 'done' };
  if (condition === 'not_started') return { word: 'Not started', tone: 'wait' };
  return { word: word(runState), tone: 'wait' };
}

function satisfiedBy(run: MapNode | undefined, gate: MapGate | null): boolean {
  if (run === undefined) return false;
  const { condition, outcome } = run.observed;
  if (condition === 'settled') return outcome === 'completed';
  // A superseded version's approval authorises nothing (pickup's
  // approvalCurrent): the gate it kept is history, not a way through.
  if (condition === 'superseded') return false;
  return gate?.state === 'approved';
}

/** Each step's depth: one past the deepest step it comes after. */
function depths(steps: NonNullable<MapGraph['steps']>): Map<string, number> {
  const out = new Map<string, number>();
  const afterOf = new Map(steps.map((step) => [step.key, step.after]));
  const visit = (key: string, seen: ReadonlySet<string>): number => {
    const known = out.get(key);
    if (known !== undefined) return known;
    if (seen.has(key)) return 0;
    const next = new Set(seen).add(key);
    const depth = Math.max(-1, ...(afterOf.get(key) ?? []).map((name) => visit(name, next))) + 1;
    out.set(key, depth);
    return depth;
  };
  for (const step of steps) visit(step.key, new Set());
  return out;
}

function outLine(step: Omit<MapStep, 'out' | 'sentence' | 'x' | 'y'>): MapStep['out'] {
  const waiting = step.after.find((one) => !one.satisfied);
  // A pending gate asks only while the step still reads as waiting at it: a
  // run observed since (in progress, settled, superseded) is newer than the
  // gate snapshot from `task.read`, and the newer observation wins.
  if (step.gate?.state === 'pending' && step.state.tone === 'gate')
    return { k: 'NEEDS', v: `A person's approval of v${String(step.gate.version)}` };
  if (waiting !== undefined) return { k: 'WAIT', v: waiting.key };
  const newest = step.runs.at(-1);
  const outcome = newest?.observed.outcome ?? null;
  if (step.state.tone === 'bad')
    return { k: 'STOP', v: newest?.observed.fault ?? word(outcome ?? '') };
  if (step.satisfied) return { k: 'OUT', v: 'Done' };
  return { k: 'OUT', v: 'Not produced yet' };
}

function sentenceOf(after: MapStep['after']): string {
  if (after.length === 0) return 'Starts the plan';
  const keys = after.map((one) => one.key).join(' + ');
  return `${after.some((one) => !one.satisfied) ? 'Waiting on' : 'After'} ${keys}`;
}

type Steps = NonNullable<MapGraph['steps']>;

/** Each step in its column and row, with its runs, gate, state and whether it is satisfied. */
function readSteps(graph: MapGraph, steps: Steps, gates: readonly MapGate[]) {
  const depth = depths(steps);
  const rows = new Map<number, number>();
  return steps.map((step) => {
    const col = depth.get(step.key) ?? 0;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    const runs = step.runIds.flatMap((id) => graph.nodes.filter((node) => node.nodeId === id));
    const newest = runs.at(-1);
    const gate = gates.find((one) => one.runId === newest?.nodeId) ?? null;
    return {
      key: step.key,
      title: step.title,
      col,
      row,
      runs,
      gate,
      after: step.after,
      terminal: !steps.some((other) => other.after.includes(step.key)),
      state: stateOf(newest, gate),
      satisfied: satisfiedBy(newest, gate),
    };
  });
}

function placeSteps(graph: MapGraph, steps: Steps, gates: readonly MapGate[]): MapStep[] {
  const read = readSteps(graph, steps, gates);
  const satisfied = new Map(read.map((one) => [one.key, one.satisfied]));
  return read.map((one) => {
    const after = one.after.map((key) => ({ key, satisfied: satisfied.get(key) ?? false }));
    const partial = Object.assign({}, one, { after });
    return Object.assign(partial, {
      x: GEO.padX + one.col * (GEO.nodeW + GEO.colGap),
      y: GEO.padTop + GEO.stageH + GEO.rowGap + one.row * (GEO.nodeH + GEO.rowGap),
      sentence: sentenceOf(after),
      out: outLine(partial),
    });
  });
}

/** The map for one task's graph and gates. */
export function executionMap(graph: MapGraph, gates: readonly MapGate[]): ExecutionMapView {
  const steps = graph.steps ?? [];
  if (graph.plan !== 'bound' || steps.length === 0) {
    return graph.nodes.length === 0
      ? { kind: 'no-run' }
      : { kind: 'unbound', runs: graph.nodes.length };
  }
  const placed = placeSteps(graph, steps, gates);
  const cols = Math.max(1, ...placed.map((step) => step.col + 1));
  const most = Math.max(1, ...placed.map((step) => step.row + 1));
  const { paths, joins } = routeRail(placed);
  const pick = (tone: Tone): string | undefined =>
    placed.find((step) => step.state.tone === tone)?.key;
  return {
    kind: 'bound',
    steps: placed,
    paths,
    joins,
    stages: cols,
    width: GEO.padX * 2 + cols * GEO.nodeW + (cols - 1) * GEO.colGap,
    height:
      GEO.padTop +
      GEO.stageH +
      GEO.rowGap +
      most * GEO.nodeH +
      (most - 1) * GEO.rowGap +
      GEO.padBottom,
    orphans: graph.nodes.filter((node) => node.condition === 'unplanned'),
    preselect: pick('gate') ?? pick('run') ?? pick('bad') ?? null,
  };
}
