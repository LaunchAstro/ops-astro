// SPDX-License-Identifier: AGPL-3.0-only
//
// What agent runs cost (U39), in money minor units per run (ORCH37):
// `finance.skill_costs`, skill costing on Connections & signal (MP-14-9), and
// `finance.agent_costs`, what our agents cost us for a period (MP-14-6).
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
// at most one definition (its pin's one slot), so no run is shared yet.

import {
  grantedScopes,
  listRunCosts,
  subjectsOf,
  type RunCostRow,
  type Session,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import type {
  AgentCostRowView,
  AgentCostsResult,
  AttributionSplitView,
  CostAttachment,
  SkillCostsResult,
  SkillCostView,
  SkillFigure,
  Unavailable,
} from '../../../core-wire/src/index.ts';
import { invalid } from '../commands/operands.ts';
import { refuseCommand, type CommandRefusal } from '../commands/refusal.ts';

const unavailable = (reason: string): Unavailable => ({ available: false, reason });
const USAGE = unavailable('The broker does not record each call’s input and output yet.');
const MODELS = unavailable('The broker does not record each call’s exact model id yet.');
const DOCUMENT = unavailable('Process documents open at their Docs address once Docs exists.');
const UNPRICED = 'A call’s cost is not known yet: it is still running or its liability is unknown.';

/** The scopes the caller reads costs at, or the refusal for holding them nowhere. */
async function financeScopes(tx: TenantQuery, session: Session) {
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
}

function runsOf(rows: readonly RunCostRow[]): readonly Run[] {
  const runs = new Map<string, Run>();
  for (const row of rows) {
    const key = `${row.runId}:${row.currency}`;
    const known = runs.get(key);
    const cost = row.openCalls > 0 ? null : BigInt(row.settledMinor);
    runs.set(key, {
      runId: row.runId,
      taskId: row.taskId,
      currency: row.currency,
      skill: row.skillId === null ? null : { id: row.skillId, name: String(row.skillName) },
      finished: row.finished,
      cost:
        known === undefined
          ? cost
          : known.cost === null || cost === null
            ? null
            : known.cost + cost,
    });
  }
  return [...runs.values()];
}

const sum = (amounts: readonly bigint[]): bigint => amounts.reduce((all, one) => all + one, 0n);

/** The mean of whole minor units, rounded half up. */
const mean = (amounts: readonly bigint[]): string =>
  ((sum(amounts) * 2n + BigInt(amounts.length)) / (2n * BigInt(amounts.length))).toString();

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
    usage: USAGE,
    models: MODELS,
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

function groupBy<T>(items: readonly T[], key: (item: T) => string): readonly (readonly T[])[] {
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

/** The window a cost log reads: an ISO start before an ISO end. */
export interface CostPeriodOperands {
  readonly from: string;
  readonly to: string;
}

/** An ISO date-time's instant, or NaN for anything else. */
const instant = (value: unknown): number =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(value) ? Date.parse(value) : Number.NaN;

const PERIOD_FIX = 'Send from and to as ISO date-times, from before to.';

export function parseCostPeriod(
  body: Readonly<Record<string, unknown>>,
):
  | { readonly ok: true; readonly operands: CostPeriodOperands }
  | { readonly ok: false; readonly refusal: CommandRefusal } {
  const { from, to } = body;
  if (Number.isNaN(instant(from))) return { ok: false, refusal: invalid('from', PERIOD_FIX) };
  if (Number.isNaN(instant(to)) || instant(to) <= instant(from)) {
    return { ok: false, refusal: invalid('to', PERIOD_FIX) };
  }
  return { ok: true, operands: { from: String(from), to: String(to) } };
}

function attachmentOf(row: RunCostRow): CostAttachment {
  return row.clientId === null
    ? { kind: 'agency' }
    : { kind: 'client', id: row.clientId, name: row.clientName };
}

function logRow(row: RunCostRow): AgentCostRowView {
  const unpriced = row.openCalls > 0;
  return {
    runId: row.runId,
    taskId: row.taskId,
    agentActorId: row.agentActorId,
    attachment: attachmentOf(row),
    currency: row.currency,
    cost: unpriced ? null : row.settledMinor,
    unpriced: unpriced ? UNPRICED : null,
    startedAt: row.startedAt.toISOString(),
    model: MODELS,
  };
}

const attachmentKey = (row: AgentCostRowView): string =>
  row.attachment.kind === 'client' ? row.attachment.id : 'agency';

/** What one group of log rows adds up to, beside the key it was grouped by. */
function totalOf<K extends object>(key: K, rows: readonly AgentCostRowView[]) {
  const costs = rows.flatMap((row) => (row.cost === null ? [] : [BigInt(row.cost)]));
  return {
    ...key,
    currency: String(rows[0]?.currency),
    runs: new Set(rows.map((row) => row.runId)).size,
    unpricedRuns: new Set(rows.filter((row) => row.cost === null).map((row) => row.runId)).size,
    total: String(sum(costs)),
  };
}

export async function readAgentCosts(
  tx: TenantQuery,
  session: Session,
  period: CostPeriodOperands,
): Promise<AgentCostsResult | CommandRefusal> {
  const scopes = await financeScopes(tx, session);
  if (!Array.isArray(scopes)) return scopes as CommandRefusal;
  const window = { from: new Date(period.from), to: new Date(period.to) };
  const runs = (await listRunCosts(tx, scopes, window)).map((row) => logRow(row));
  return {
    ok: true,
    period: { from: window.from.toISOString(), to: window.to.toISOString() },
    runs,
    byAgent: groupBy(runs, (row) => `${row.agentActorId}:${row.currency}`).map((rows) =>
      totalOf({ agentActorId: rows[0]?.agentActorId ?? null }, rows),
    ),
    byAttachment: groupBy(runs, (row) => `${attachmentKey(row)}:${row.currency}`).map((rows) =>
      totalOf({ attachment: rows[0]?.attachment ?? ({ kind: 'agency' } as const) }, rows),
    ),
  };
}
