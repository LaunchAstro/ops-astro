// SPDX-License-Identifier: AGPL-3.0-only
//
// `finance.agent_costs`, what our agents cost us for a period (MP-14-6, U39):
// the cost log, one row per run and agent, and its totals per agent and per
// client summed from those same rows. It reads `listRunCosts` by the scopes
// the caller holds `finance:read` at, as skill costing does (`costs.ts`).

import {
  listRunCosts,
  type RunCostRow,
  type Session,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import type {
  AgentCostRowView,
  AgentCostsResult,
  CostAttachment,
} from '../../../core-wire/src/index.ts';
import { invalid } from '../commands/operands.ts';
import type { CommandRefusal } from '../commands/refusal.ts';
import { financeScopes, groupBy, rowModels, sum } from './costs.ts';

const UNPRICED = 'A call’s cost is not known yet: it is still running or its liability is unknown.';

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
    models: rowModels(row),
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
