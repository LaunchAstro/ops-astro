// SPDX-License-Identifier: AGPL-3.0-only
//
// `finance.agent_costs`, what our agents cost us for a period (MP-14-6):
// the cost log, one row per run and agent, and its totals per agent and per
// client summed from those same rows. A run with an open call is unpriced in
// every one of its rows (`listRunCosts` counts the run's open calls), so no
// part of it reaches a total. It reads `listRunCosts` by the scopes
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
import { refuseCommand, type CommandRefusal } from '../commands/refusal.ts';
import {
  financeScopes,
  groupBy,
  parseNoCostOperands,
  rowModels,
  sum,
  type CostOperands,
} from './costs.ts';

const UNPRICED =
  'A call in this run is not priced yet: it is held, still running or its liability is unknown.';

/** The window a cost log reads, an ISO start before an ISO end, and any key it does not take. */
export interface CostPeriodOperands extends CostOperands {
  readonly from: string;
  readonly to: string;
}

/**
 * The whole of an ISO date-time with its zone, `Z` or an offset: one without
 * would be read in the server's own zone, so the same request would cover
 * different runs on different hosts. Its fields are taken apart here, so an
 * impossible one can be refused rather than rolled into the next real one.
 */
const ZONED =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/u;

/** The days in a month of the proleptic Gregorian calendar ISO 8601 counts in. */
function daysIn(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Whether each field is one the calendar and the clock have: a month of the
 * year, a day of that month, an hour before 24, a minute and second before 60,
 * and an offset no further than 14 hours from UTC.
 */
function realFields(fields: readonly number[]): boolean {
  const [
    year = 0,
    month = 0,
    day = 0,
    hour = 0,
    minute = 0,
    second = 0,
    offHours = 0,
    offMinutes = 0,
  ] = fields;
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysIn(year, month) &&
    hour < 24 &&
    minute < 60 &&
    second < 60 &&
    offMinutes < 60 &&
    offHours * 60 + offMinutes <= 14 * 60
  );
}

/**
 * A zoned ISO date-time's instant, counted from its own fields, or NaN for
 * anything else, an impossible date or time included: nothing here rolls a
 * field over into the next one, so a refusal is the only way past a bad one.
 */
function instant(value: unknown): number {
  const found = typeof value === 'string' ? ZONED.exec(value) : null;
  if (found === null) return Number.NaN;
  const [, ...parts] = found;
  const [year, month, day, hour, minute, second, fraction = '', sign, offHours, offMinutes] = parts;
  const fields = [year, month, day, hour, minute, second, offHours, offMinutes].map((one) =>
    Number(one ?? '0'),
  );
  if (!realFields(fields)) return Number.NaN;
  const [y = 0, mo = 0, d = 0, h = 0, mi = 0, se = 0, oh = 0, om = 0] = fields;
  const at = new Date(0);
  at.setUTCFullYear(y, mo - 1, d);
  at.setUTCHours(h, mi, se, Number(fraction.padEnd(3, '0')));
  return at.getTime() - (sign === '-' ? -1 : 1) * (oh * 60 + om) * 60_000;
}

/** The most rows one log answers, so no period hands out every run there is. */
const LOG_ROWS = 1000;

const PERIOD_FIX = 'Send from and to as ISO date-times, from before to.';
const fixFor = (bound: number): string =>
  `Ask for a shorter period: more than ${String(bound)} runs fall in this one.`;

export function parseCostPeriod(
  body: Readonly<Record<string, unknown>>,
):
  | { readonly ok: true; readonly operands: CostPeriodOperands }
  | { readonly ok: false; readonly refusal: CommandRefusal } {
  const [from, to] = [instant(body['from']), instant(body['to'])];
  if (Number.isNaN(from)) return { ok: false, refusal: invalid('from', PERIOD_FIX) };
  if (Number.isNaN(to) || to <= from) return { ok: false, refusal: invalid('to', PERIOD_FIX) };
  const { unknown } = parseNoCostOperands(body, ['from', 'to']).operands;
  return { ok: true, operands: { from: String(body['from']), to: String(body['to']), unknown } };
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
  bound: number = LOG_ROWS,
): Promise<AgentCostsResult | CommandRefusal> {
  const scopes = await financeScopes(tx, session, period);
  if (!Array.isArray(scopes)) return scopes as CommandRefusal;
  const window = { from: new Date(period.from), to: new Date(period.to) };
  const found = await listRunCosts(tx, scopes, { ...window, rows: bound });
  if (found.length > bound) {
    return refuseCommand('FIELD_VALUE_INVALID', ['from', 'to'], [fixFor(bound)]);
  }
  const runs = found.map((row) => logRow(row));
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
