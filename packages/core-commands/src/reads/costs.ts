// SPDX-License-Identifier: AGPL-3.0-only
//
// What agent runs cost (U39), in money minor units per run (ORCH37):
// `finance.skill_costs`, skill costing on Connections & signal (MP-14-9);
// `finance.agent_costs`, what our agents cost us for a period (MP-14-6), is
// in `agent-costs.ts` over the same helpers.
//
// Both are asked by the scopes the caller holds `finance:read` at, and both
// are shapes of one statement (`listRunCosts`), filtered inside it: a
// business-wide holder sees every run, a client-scoped holder that client's
// runs only, in rows and in every total, since each total is summed from the
// same rows. A caller holding the key nowhere is refused rather than shown
// an empty page. A run with a call whose cost is not known yet is unpriced:
// counted, in no figure and no total, and it says so.
//
// A skill's figure follows the mockup's attribution rule: its mean only from
// runs that used it alone and only from more than one priced run, with the
// spread beside it; one priced run is that run, never an average. A run names
// at most one definition (its pin's one slot), so no run is shared yet. In and
// out units take the same rule over runs whose every call recorded them; model
// ids are every exact id called, with the calls that named none counted.

import {
  grantedScopes,
  listRunCosts,
  subjectsOf,
  type RunCostRow,
  type Scope,
  type Session,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import type {
  AttributionSplitView,
  ModelsView,
  SkillCostsResult,
  SkillCostView,
  SkillFigure,
  SkillUsageView,
  Unavailable,
} from '../../../core-wire/src/index.ts';
import { refuseCommand, type CommandRefusal } from '../commands/refusal.ts';

const DOCUMENT: Unavailable = {
  available: false,
  reason: 'Process documents open at their Docs address once Docs exists.',
};

/** The scopes the caller reads costs at, or the refusal for holding them nowhere. */
export async function financeScopes(
  tx: TenantQuery,
  session: Session,
): Promise<readonly Scope[] | CommandRefusal> {
  const scopes = await grantedScopes(tx, subjectsOf(session), 'finance', 'read');
  return scopes.length > 0
    ? scopes
    : refuseCommand(
        'SCOPE_NOT_GRANTED',
        ['finance:read'],
        ['no live grant covers it', 'ask a holder who may delegate'],
      );
}

/** One run in one currency: its agents' rows summed. */
interface Run {
  readonly runId: string;
  readonly taskId: string;
  readonly currency: string;
  readonly skill: { readonly id: string; readonly name: string } | null;
  readonly finished: boolean;
  /** Its spend, or null when a call's cost is not known yet. */
  readonly cost: bigint | null;
  /** Its input and output units, or null unless priced and every call recorded them. */
  readonly units: { readonly input: bigint; readonly output: bigint } | null;
  readonly models: ModelsView;
}

const modelsOf = (all: readonly ModelsView[]): ModelsView => ({
  ids: [...new Set(all.flatMap((one) => one.ids))].toSorted(),
  unnamedCalls: all.reduce((count, one) => count + one.unnamedCalls, 0),
});

export const rowModels = (row: RunCostRow): ModelsView => ({
  ids: row.modelIds.toSorted(),
  unnamedCalls: row.unnamedCalls,
});

export const sum = (amounts: readonly bigint[]): bigint =>
  amounts.reduce((all, one) => all + one, 0n);

/** The mean of whole minor units, rounded half up. */
const mean = (amounts: readonly bigint[]): string =>
  ((sum(amounts) * 2n + BigInt(amounts.length)) / (2n * BigInt(amounts.length))).toString();

/** One run in one currency from its agents' rows: known only when every row is. */
function runOf(rows: readonly RunCostRow[]): Run {
  const [row] = rows as readonly [RunCostRow, ...RunCostRow[]];
  const total = (pick: (one: RunCostRow) => string) => sum(rows.map((one) => BigInt(pick(one))));
  const priced = rows.every((one) => one.openCalls === 0);
  const measured = priced && rows.every((one) => one.unmeasuredCalls === 0);
  return {
    runId: row.runId,
    taskId: row.taskId,
    currency: row.currency,
    skill: row.skillId === null ? null : { id: row.skillId, name: String(row.skillName) },
    finished: row.finished,
    cost: priced ? total((one) => one.settledMinor) : null,
    units: measured
      ? { input: total((one) => one.inputUnits), output: total((one) => one.outputUnits) }
      : null,
    models: modelsOf(rows.map((one) => rowModels(one))),
  };
}

const runsOf = (rows: readonly RunCostRow[]): readonly Run[] =>
  groupBy(rows, (row) => `${row.runId}:${row.currency}`).map((group) => runOf(group));

const priced = (runs: readonly Run[]): readonly bigint[] =>
  runs.flatMap((run) => (run.cost === null ? [] : [run.cost]));

function figureOf(runs: readonly Run[]): SkillFigure {
  const costs = priced(runs);
  if (costs.length === 0) return { kind: 'none' };
  if (costs.length === 1) return { kind: 'one', amount: String(costs[0]) };
  const finished = priced(runs.filter((run) => run.finished));
  const sorted = costs.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    kind: 'mean',
    mean: mean(costs),
    lo: String(sorted[0]),
    hi: String(sorted.at(-1)),
    finishedMean: finished.length > 1 ? mean(finished) : null,
  };
}

function usageOf(runs: readonly Run[]): SkillUsageView {
  const measured = runs.flatMap((run) => (run.units === null ? [] : [run.units]));
  const many = measured.length > 1;
  return {
    measuredRuns: measured.length,
    meanIn: many ? mean(measured.map((one) => one.input)) : null,
    meanOut: many ? mean(measured.map((one) => one.output)) : null,
  };
}

function skillRow(runs: readonly Run[]): SkillCostView {
  const [first] = runs;
  if (first?.skill === null || first === undefined) throw new Error('a skill row needs a run');
  return {
    skillId: first.skill.id,
    name: first.skill.name,
    currency: first.currency,
    runs: runs.length,
    soloRuns: runs.length,
    sharedRuns: 0,
    unpricedRuns: runs.filter((run) => run.cost === null).length,
    tasks: new Set(runs.map((run) => run.taskId)).size,
    figure: figureOf(runs),
    soloTotal: String(sum(priced(runs))),
    usage: usageOf(runs),
    models: modelsOf(runs.map((run) => run.models)),
    document: DOCUMENT,
  };
}

/** The figure a row sorts by: its mean or its one run, else nothing. */
const weight = (row: SkillCostView): bigint =>
  row.figure.kind === 'mean'
    ? BigInt(row.figure.mean)
    : row.figure.kind === 'one'
      ? BigInt(row.figure.amount)
      : -1n;

/** Most observed first, as the mockup orders it. */
function byObservation(a: SkillCostView, b: SkillCostView): number {
  const heavier = weight(b) - weight(a);
  return (
    b.soloRuns - a.soloRuns ||
    b.runs - a.runs ||
    (heavier > 0n ? 1 : heavier < 0n ? -1 : 0) ||
    a.name.localeCompare(b.name) ||
    a.skillId.localeCompare(b.skillId)
  );
}

export function groupBy<T>(
  items: readonly T[],
  key: (item: T) => string,
): readonly (readonly T[])[] {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return [...groups.values()];
}

function splitOf(runs: readonly Run[]): AttributionSplitView {
  const bucket = (some: readonly Run[]) => ({
    runs: some.length,
    total: String(sum(priced(some))),
  });
  return {
    currency: String(runs[0]?.currency),
    runs: runs.length,
    total: String(sum(priced(runs))),
    solo: bucket(runs.filter((run) => run.skill !== null)),
    shared: { runs: 0, total: '0' },
    unattributed: bucket(runs.filter((run) => run.skill === null)),
    unpricedRuns: runs.filter((run) => run.cost === null).length,
  };
}

export async function readSkillCosts(
  tx: TenantQuery,
  session: Session,
): Promise<SkillCostsResult | CommandRefusal> {
  const scopes = await financeScopes(tx, session);
  if (!Array.isArray(scopes)) return scopes as CommandRefusal;
  const runs = runsOf(await listRunCosts(tx, scopes));
  if (runs.length === 0) return { ok: true, costing: null };
  const skilled = runs.filter((run) => run.skill !== null);
  return {
    ok: true,
    costing: {
      skills: groupBy(skilled, (run) => `${run.skill?.id}:${run.currency}`)
        .map((group) => skillRow(group))
        .toSorted(byObservation),
      split: groupBy(runs, (run) => run.currency)
        .map((group) => splitOf(group))
        .toSorted((a, b) => a.currency.localeCompare(b.currency)),
    },
  };
}
