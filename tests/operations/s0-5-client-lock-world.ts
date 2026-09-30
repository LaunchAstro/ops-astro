// SPDX-License-Identifier: AGPL-3.0-only
//
// What `s0-5-client-lock.test.ts` runs: the task-content commands read from
// the catalogue, each fixture's marker or the rows that name its task, the
// client change through the CLI and the API, and the interleaving of a
// content write with a client change under the task's row lock.

import { randomUUID } from 'node:crypto';
import {
  COMMAND_EFFECTS,
  COMMAND_SURFACE,
  type CommandDeclaration,
  type CommandName,
} from '../../packages/core-wire/src/index.ts';
import type { Harness } from '../acceptance/role-case-harness.ts';
import { both, refusedAlike } from '../cli/cli-parity.ts';

/** Bookkeeping every call writes; never content of its own. */
const BOOKKEEPING: ReadonlySet<string> = new Set([
  'audit_events',
  'operations',
  'authentication_attempts',
]);

/** Commands that write a client-scoped kind but are not content on an existing task. */
const NOT_CONTENT: Readonly<Record<string, string>> = {
  'task.create': 'the creation itself',
  'task.set_party': 'a client change, which the lock allows while the task is empty',
  'client.create': 'writes a client, not a task',
  'task.purge': 'removes the task; nothing is left to change the client of',
};

export const CONTENT: readonly CommandDeclaration[] = COMMAND_SURFACE.filter(
  ({ name }) =>
    !(name in NOT_CONTENT) && COMMAND_EFFECTS[name].writes.some((kind) => kind.scope === 'client'),
);

let harness: Harness;

/** The suite's harness, set once in its `beforeAll`. */
export function useHarness(made: Harness): void {
  harness = made;
}
/** The task each content command's fixture touched, from its marker. */
export const touched: Map<CommandName, string> = new Map<CommandName, string>();

const admin = async <T>(sql: string, parameters: unknown[] = []): Promise<T[]> =>
  (await harness.world.db.admin.execute<T & Record<string, unknown>>(sql, parameters)) as T[];

async function taskRevisions(): Promise<ReadonlyMap<string, string>> {
  const rows = await admin<{ id: string; revision: string }>(
    `select r.id, r.revision::text as revision from records r
      where r.record_type_id = (select record_type_id from records where id = $1)`,
    [harness.clients[0]!.task],
  );
  return new Map(rows.map((row) => [row.id, row.revision]));
}

async function lastSeq(): Promise<string> {
  const [row] = await admin<{ seq: string }>(
    'select coalesce(max(seq), 0)::text as seq from audit_events',
  );
  return row!.seq;
}

/** Each public table's rows as one digest, read past row security. */
async function fingerprint(): Promise<ReadonlyMap<string, string>> {
  const tables = await admin<{ name: string }>(
    `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`,
  );
  const union = tables
    .map(
      ({ name }) =>
        `select '${name}' as name, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest from public.${name} t`,
    )
    .join(' union all ');
  const rows = await admin<{ name: string; digest: string }>(union);
  return new Map(rows.map((row) => [row.name, row.digest]));
}

function changed(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  return [...after.keys()].filter(
    (table) => !BOOKKEEPING.has(table) && after.get(table) !== before.get(table),
  );
}

async function bodyFor(declaration: CommandDeclaration): Promise<Record<string, unknown>> {
  if (declaration.name === 'delegation.revoke') {
    const task = await harness.freshTask(`s0-5 lock ${randomUUID()}`);
    const decided = await harness.reserve(task, 'draft_the_lock_reply');
    const reservationId = (decided.body['detail'] as Record<string, unknown>)['reservationId'];
    const picked = await harness.asAgent('task.pickup', { reservationId });
    return { delegationId: (picked.body['detail'] as Record<string, unknown>)['delegationId'] };
  }
  const prepared = await harness.positiveBody(declaration);
  if ('exception' in prepared) throw new Error(`${declaration.name}: ${prepared.exception}`);
  return { ...prepared.body };
}

export async function newClient(): Promise<string> {
  const made = await harness.asPerson('client.create', { name: `s0-5 lock ${randomUUID()}` });
  return String((made.body['detail'] as Record<string, unknown>)['clientId']);
}

export async function revisionOf(taskId: string): Promise<number> {
  const [row] = await admin<{ revision: string }>(
    'select revision::text as revision from records where id = $1',
    [taskId],
  );
  return Number(row!.revision);
}

export async function setPartyBody(
  taskId: string,
  client: string,
): Promise<Record<string, unknown>> {
  return { recordId: taskId, expectedRevision: await revisionOf(taskId), fields: { client } };
}

/**
 * Held (the marker's second half): these commands run under the runtime's own
 * lock order (cap, envelope, then task) or write a row other than the task, and
 * leave no history event with a new revision on the task. Their content is
 * found by the rows that name the task, which the lock reads; the marker on
 * each waits for the runtime's lock order to take the task first.
 */
const MARKER_HELD: ReadonlySet<string> = new Set([
  'task.comment',
  'task.propose',
  'task.decide',
  'task.pickup',
  'task.handback',
  'task.restore',
  'delegation.revoke',
  'task.cancel',
  'task.restart',
  'task.heartbeat',
  'task.dispatch',
  'task.observe',
  'budget.top_up',
  'budget.record_outcome',
  'budget.write_off',
]);

/** Per task, a digest of every row that names it, in the tables the lock reads. */
async function rowsNaming(): Promise<ReadonlyMap<string, string>> {
  const sources = [
    ['record_links', 'to_record_id'],
    ['proposal_lineages', 'task_id'],
    ['planned_runs', 'task_id'],
    ['task_envelopes', 'task_id'],
    ['leases', 'task_id'],
    ['alerts', 'task_id'],
  ]
    .map(
      ([table, column]) =>
        `select ${column}::text as task, md5(string_agg(t::text, '|' order by t::text)) as digest
           from public.${table} t group by ${column}`,
    )
    .join(' union all ');
  const rows = await admin<{ task: string; digest: string }>(
    `select task, md5(string_agg(digest, '|' order by digest)) as digest from (${sources}) s group by task`,
  );
  return new Map(rows.map((row) => [row.task, row.digest]));
}

/** The task a body names: itself, through its lease, or through its trash batch. */
async function taskNamedBy(body: Record<string, unknown>): Promise<string | undefined> {
  const ids = Object.values(body).filter((value): value is string => typeof value === 'string');
  const [row] = await admin<{ task: string }>(
    `select id::text as task from records where id = any($1::uuid[]) or trash_batch_id = any($1::uuid[])
     union all select task_id::text from leases where id = any($1::uuid[]) limit 1`,
    [ids.filter((id) => /^[\da-f-]{36}$/u.test(id))],
  );
  return row?.task;
}

/** Runs one content command's fixture; what is wrong with its marker, if anything. */
export async function markerFaults(declaration: CommandDeclaration): Promise<string[]> {
  const { name } = declaration;
  const body = await bodyFor(declaration);
  const [revisions, named, seq] = [await taskRevisions(), await rowsNaming(), await lastSeq()];
  const named0 = await taskNamedBy(body);
  const answer = await harness.asPerson(name, body);
  if (answer.code !== 'ok') return [`${name}: its fixture was refused ${answer.code}`];
  const marked = await admin<{ subject: string }>(
    `select distinct a.subject_record_id::text as subject from audit_events a
      where a.seq > $1 and a.command = $2 and a.outcome = 'applied' and a.subject_record_id = any($3::uuid[])`,
    [seq, name, [...revisions.keys()]],
  );
  const after = await taskRevisions();
  const bumped = marked.filter(({ subject }) => after.get(subject) !== revisions.get(subject));
  if (MARKER_HELD.has(name)) {
    const nowNamed = await rowsNaming();
    const rowTouched = [...nowNamed.keys()].find((task) => nowNamed.get(task) !== named.get(task));
    const task = bumped[0]?.subject ?? rowTouched ?? named0;
    if (task === undefined) return [`${name}: held marker, and no row names the task it touched`];
    touched.set(name, task);
    return [];
  }
  if (bumped.length === 0) return [`${name}: no history event with a new revision on any task`];
  touched.set(name, bumped[0]!.subject);
  return [];
}

/** The client change on a task holding content: refused alike through the CLI and the API, nothing written. */
export async function lockFaults(
  name: CommandName,
  taskId: string,
  client: string,
): Promise<string[]> {
  const before = await fingerprint();
  const pair = await both(
    harness.world.api,
    'task.set_party',
    await setPartyBody(taskId, client),
    harness.world.ada.token,
  );
  const found: string[] = [];
  try {
    // A trashed task is answered as a missing one, before any lock or history.
    if (name === 'task.trash') refusedAlike(pair, 404, 'NOT_FOUND');
    else refusedAlike(pair, 409, 'CLIENT_LOCKED');
  } catch {
    found.push(`${name}: set_party answered ${pair.api.status} ${String(pair.api.body['code'])}`);
  }
  return [
    ...found,
    ...changed(before, await fingerprint()).map((table) => `${name}: wrote ${table}`),
  ];
}

/** Every task-content kind no fixture reached; a kind with no case fails. */
export function kindsUnreached(): string[] {
  const kinds = new Set(
    CONTENT.flatMap(({ name }) =>
      COMMAND_EFFECTS[name].writes.filter((k) => k.scope === 'client'),
    ).map((k) => k.kind),
  );
  const reached = new Set(
    [...touched.keys()].flatMap((name) => COMMAND_EFFECTS[name].writes.map((k) => k.kind)),
  );
  return [...kinds].filter((kind) => !reached.has(kind));
}
