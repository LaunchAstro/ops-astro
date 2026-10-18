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
//
// Owner line 72 (ops-astro-roadmap `docs/decisions/execution.md`, 28 September
// and 13 October 2026) judges by provenance at the time of each write: a task a
// person wrote while holding no staff role (a client's contact, a guest) is
// `outside` too. A business-internal field is marked `ownerWork` when a person
// then holding the owner role created its task and it has no client key. Only
// that mark lets free text take the owner's subscription (`data-class.ts`). An
// agent's write, a summary included, makes the task `outside`, so the stricter
// class survives.

import type { FieldSource } from '../../core-connectors/src/index.ts';
import type { CredentialKind } from './credentials.ts';
import { TASK_SPINE } from '../../core-records/src/index.ts';
import type { ModelCallField, ResolvedField } from './broker-types.ts';

/** The run's task as a source, read under its share lock. */
export interface TaskSource {
  readonly id: string;
  readonly live: boolean;
  /** The task's revision, read with it: a turn names the one it read (#1623 R3). */
  readonly revision: number;
  /** The spine's `source`: `<actor kind>:<entry point>`, derived by the server. */
  readonly entered: string | null;
  /** Whether the register names an applied write on it by anyone but a person. */
  readonly othersWrote: boolean;
  /** Whether a person who held no staff role when they wrote it has written it (owner line 72). */
  readonly clientTyped: boolean;
  /** Owner line 72 by source: a person then holding the owner role created it, and it has no client key. */
  readonly ownerWork: boolean;
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
  // #1904: a pinned read names the task in the register; it writes none of its data.
  'definition.read',
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

/** Entered by one of the business's own people, and written since by no agent, worker or client. */
export function businessInternal(task: TaskSource): boolean {
  return (
    !task.othersWrote &&
    !task.clientTyped &&
    task.entered !== null &&
    ENTERED_BY_OWN_PEOPLE.has(task.entered)
  );
}

/** A live task that is business-internal and the owner's own work (owner line 72). */
export function ownersOwn(task: TaskSource): boolean {
  return task.live && businessInternal(task) && task.ownerWork;
}

/** Each field's value and the source the broker found for it; a claim of `business_internal` counts as `outside`. */
export function resolveFields(fields: readonly ModelCallField[], task: TaskSource): Resolution {
  const internal = businessInternal(task);
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
    resolved.push({ name: field.name, source, value, ownerWork: internal && task.ownerWork });
  }
  return { ok: true, fields: resolved };
}

/** A route as the client refusal reads it. */
interface OfferedRoute {
  readonly provider: string;
  readonly credentialKind: CredentialKind;
}

/**
 * Why a client's work is refused, before any route is chosen. Owner line 72
 * (ops-astro-roadmap `docs/decisions/execution.md`, 28 September and 13 October
 * 2026): where any subscription route of the operation's provider could carry
 * it, by the subscription's name; otherwise C60's `CLIENT_MODEL_USE_OFF`.
 */
export function clientRefusal(
  routes: readonly OfferedRoute[],
  operation: { readonly provider: string },
): 'SUBSCRIPTION_NOT_FOR_CLIENT_WORK' | 'CLIENT_MODEL_USE_OFF' {
  const offered = routes.some(
    (route) => route.provider === operation.provider && route.credentialKind === 'subscription',
  );
  return offered ? 'SUBSCRIPTION_NOT_FOR_CLIENT_WORK' : 'CLIENT_MODEL_USE_OFF';
}
