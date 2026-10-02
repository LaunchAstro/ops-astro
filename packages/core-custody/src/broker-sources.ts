// SPDX-License-Identifier: AGPL-3.0-only
//
// Where a field's value came from, found by the broker (S3, owner line 72).
//
// The one class a cloud route may carry is allowed only on a field whose
// source is business-internal: no client key, not entered by a client person,
// a guest or an outside source (AW-01). The caller cannot say so. A field
// that wants it is bound to its row, `from: { recordId, key }`, and the
// broker reads the value from the row it already holds `for share`: the
// run's own task (`lockTask`).
//
// What may be bound is what the caller may read. An agent is a delegate
// working one task and is shown what an external reader is shown (I09), so
// a bound field names the run's own task and a field the task spine marks
// `shared`. Anything else (another task of the same business, another
// business's row, a made-up id, a field the agent is not shown, a key the
// task does not hold as text, or a task in the trash) cannot be read, and
// refuses the call in the same words whoever's row it was: its content
// would otherwise come back to the caller in the model's answer.
//
// The task is a business-internal source only when it was entered by one of
// the business's own people (its spine `source`, derived by the server from
// the actor kind and the entry point, ADR 0037, is a person's through the
// app, the API or the command line) and no agent or worker has an applied
// operation on it other than those known to leave its data alone. A command
// not on that list counts as a write, so a new one fails closed. A task a
// client is on never gets here: C60 refuses it first. A bound field that is
// not business-internal is `outside`, so it reaches a local route only.

import type { FieldSource } from '../../core-connectors/src/index.ts';
import { TASK_SPINE } from '../../core-records/src/index.ts';
import type { ModelCallField, ResolvedField } from './broker-types.ts';

/** The run's task as a source, read under its share lock. */
export interface TaskSource {
  readonly id: string;
  readonly live: boolean;
  /** The spine's `source`: `<actor kind>:<entry point>`, derived by the server. */
  readonly entered: string | null;
  /** Whether the register names an applied write on it by anyone but a person. */
  readonly othersWrote: boolean;
  readonly data: Readonly<Record<string, unknown>>;
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

/** The task fields an external reader, and so the agent, is shown. */
const BINDABLE: ReadonlySet<string> = new Set(
  TASK_SPINE.filter((field) => field.visibilityClass === 'shared').map((field) => field.key),
);

export type Resolution =
  | { readonly ok: true; readonly fields: readonly ResolvedField[] }
  | { readonly ok: false; readonly code: 'SOURCE_UNREADABLE' };

function valueOf(
  task: TaskSource,
  from: { readonly recordId: string; readonly key: string },
): string | undefined {
  if (from.recordId !== task.id || !task.live || !BINDABLE.has(from.key)) return undefined;
  const value = Object.hasOwn(task.data, from.key) ? task.data[from.key] : undefined;
  return typeof value === 'string' ? value : undefined;
}

/** Each field's value and the source the broker found for it; a claim of `business_internal` counts as `outside`. */
export function resolveFields(fields: readonly ModelCallField[], task: TaskSource): Resolution {
  const internal =
    !task.othersWrote && task.entered !== null && ENTERED_BY_OWN_PEOPLE.has(task.entered);
  const resolved: ResolvedField[] = [];
  for (const field of fields) {
    if (!('from' in field)) {
      const source = field.source === 'business_internal' ? 'outside' : field.source;
      resolved.push({ name: field.name, source, value: field.value });
      continue;
    }
    const value = valueOf(task, field.from);
    if (value === undefined) return { ok: false, code: 'SOURCE_UNREADABLE' };
    const source: FieldSource = internal ? 'business_internal' : 'outside';
    resolved.push({ name: field.name, source, value });
  }
  return { ok: true, fields: resolved };
}
