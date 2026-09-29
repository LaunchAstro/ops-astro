// SPDX-License-Identifier: AGPL-3.0-only
//
// Where a field's value came from, found by the broker (S3, owner line 72).
//
// The one class a cloud route may carry is allowed only on a field whose
// source is business-internal: no client key, not entered by a client person,
// a guest or an outside source (AW-01). The caller cannot say so. A field
// that wants it names its row, `from: { recordId, key }`; the broker reads
// the row under the tenant's business, held `for share` in the task class
// with the run's own task (`lockTask`), and takes the value from it.
//
// A row is a business-internal source only when all of these hold:
// - it is a live task of this business (the task record type, not in the
//   trash). Other rows, comments included, are not yet a source: nothing
//   else records who entered it.
// - no client is on it: the spine's client slot is empty.
// - it was entered by one of the business's own people: its `source`,
//   derived by the server from the actor kind and the entry point (ADR 0037),
//   is a person's through the app, the API or the command line. An agent's,
//   an import's, an automation's, an integration's or an outside party's is
//   not.
// - every applied operation the register names on it, other than those
//   known to leave its data alone (reads, the lease's own steps, comments,
//   which are rows of their own, proposals and decisions), was a person's:
//   a row an agent or a worker wrote to is not. A command not on that list
//   counts as a write, so a new one fails closed.
// A readable row that fails any of these is `client_row` (a client is on it)
// or `outside`, so it may reach a local route only. A row that cannot be read
// (another business's, made up, trashed, or a key it does not hold as text)
// refuses the call, in the same words whoever's it was.

import type { FieldSource } from '../../core-connectors/src/index.ts';
import type { ModelCallField, ResolvedField } from './broker-types.ts';

/** A bound field's row, as `lockTask` read it under its share lock. */
export interface SourceRow {
  readonly live: boolean;
  readonly isTask: boolean;
  readonly clientId: string | null;
  /** The spine's `source`: `<actor kind>:<entry point>`, derived by the server. */
  readonly entered: string | null;
  /** Whether the register names an applied write on it by anyone but a person. */
  readonly othersWrote: boolean;
  readonly data: Readonly<Record<string, unknown>>;
}

/** A row of `lockTask`'s statement: the run's task, a bound row, or both. */
export interface LockedRecord {
  readonly id: string;
  readonly run_id: string;
  readonly is_run_task: boolean;
  readonly client: string | null;
  readonly live: boolean;
  readonly is_task: boolean;
  readonly bound: boolean;
  readonly data: Record<string, unknown> | null;
  readonly others_wrote: boolean | null;
}

/** The bound rows among those held, by id. */
export function sourcesOf(rows: readonly LockedRecord[]): ReadonlyMap<string, SourceRow> {
  const sources = new Map<string, SourceRow>();
  for (const row of rows) {
    if (!row.bound) continue;
    const entered = row.data?.['source'];
    sources.set(row.id, {
      live: row.live,
      isTask: row.is_task,
      clientId: row.client,
      entered: typeof entered === 'string' ? entered : null,
      othersWrote: row.others_wrote !== false,
      data: row.data ?? {},
    });
  }
  return sources;
}

/** Commands that name a task in the register without writing its data. */
export const LEAVES_ROW_DATA: readonly string[] = [
  'session.capabilities',
  'task.read',
  'task.queue',
  'task.pickup',
  'task.heartbeat',
  'task.handback',
  'task.comment',
  'task.propose',
  'task.decide',
  'model.call',
];

/** A person of the business, through one of its own surfaces. */
const ENTERED_BY_OWN_PEOPLE: ReadonlySet<string> = new Set([
  'person:app',
  'person:api',
  'person:cli',
]);

export type Resolution =
  | { readonly ok: true; readonly fields: readonly ResolvedField[] }
  | { readonly ok: false; readonly code: 'SOURCE_UNREADABLE' };

/** The rows a request's bound fields name, for `lockTask` to hold. */
export function boundRecordIds(fields: readonly ModelCallField[]): readonly string[] {
  return [...new Set(fields.flatMap((field) => ('from' in field ? [field.from.recordId] : [])))];
}

function sourceOf(row: SourceRow): FieldSource {
  if (row.clientId !== null) return 'client_row';
  const internal =
    row.isTask &&
    !row.othersWrote &&
    row.entered !== null &&
    ENTERED_BY_OWN_PEOPLE.has(row.entered);
  return internal ? 'business_internal' : 'outside';
}

/** Each field's value and the source the broker found for it; a claim of `business_internal` counts as `outside`. */
export function resolveFields(
  fields: readonly ModelCallField[],
  rows: ReadonlyMap<string, SourceRow>,
): Resolution {
  const resolved: ResolvedField[] = [];
  for (const field of fields) {
    if (!('from' in field)) {
      const source = field.source === 'business_internal' ? 'outside' : field.source;
      resolved.push({ name: field.name, source, value: field.value });
      continue;
    }
    const row = rows.get(field.from.recordId);
    const value =
      row?.live === true && Object.hasOwn(row.data, field.from.key)
        ? row.data[field.from.key]
        : undefined;
    if (row === undefined || typeof value !== 'string') {
      return { ok: false, code: 'SOURCE_UNREADABLE' };
    }
    resolved.push({ name: field.name, source: sourceOf(row), value });
  }
  return { ok: true, fields: resolved };
}
