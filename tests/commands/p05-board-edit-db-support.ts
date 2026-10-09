// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { BoardEditCustody } from '../../apps/web/src/screens/projects/board-edit-custody.ts';
import {
  BOARD_EDIT_KEY,
  type BoardEditIntent,
} from '../../apps/web/src/screens/projects/board-edit-attempt.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type { StorageLike } from '../../apps/web/src/session/storage-slot.ts';
import type { CommandName, TaskDetail } from '../../packages/core-wire/src/index.ts';
import type {
  TenantQuery,
  Session,
  VerifiedSubject,
} from '../../packages/core-records/src/index.ts';
import { withSession } from '../../packages/core-records/src/index.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { runCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import type { TimeWorld } from './time-world.ts';
export type Variant = 'title' | 'due' | 'estimate' | 'stage' | 'complete' | 'reopen';
export const VARIANTS: readonly Variant[] = [
  'title',
  'due',
  'estimate',
  'stage',
  'complete',
  'reopen',
];
export function intent(id: string, variant: Variant): BoardEditIntent {
  switch (variant) {
    case 'title':
      return {
        command: 'task.update',
        body: { recordId: id, fields: { title: 'Submitted canonical board edit' } },
      };
    case 'due':
      return { command: 'task.update', body: { recordId: id, fields: { due: null } } };
    case 'estimate':
      return {
        command: 'task.update',
        body: { recordId: id, fields: { estimated_minutes: null } },
      };
    case 'stage':
      return { command: 'task.set_stage', body: { recordId: id, fields: { stage: 'awareness' } } };
    case 'complete':
      return { command: 'task.complete', body: { recordId: id } };
    case 'reopen':
      return {
        command: 'task.reopen',
        body: { recordId: id, reason: 'Reopened from the Projects board' },
      };
  }
}
export async function task(w: TimeWorld, id: string): Promise<TaskDetail> {
  const read = await executeRead(w.db.app, w.alpha, w.taskOnly.presented, {
    read: 'task.read',
    recordId: id,
  });
  if (isCommandRefusal(read) || !('task' in read))
    throw new Error('Canonical fixture task not readable');
  return read.task;
}
export async function revoke(w: TimeWorld): Promise<void> {
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    const grants = await tx.query<{ readonly id: string }>(
      "select id from public.grants where subject_kind='person' and subject_id=$1 and collection='task' and action='write' and revoked_at is null",
      [w.taskOnly.personId],
    );
    await grants.reduce(async (prior, grant) => {
      await prior;
      await revokeGrant(tx, grant.id);
    }, Promise.resolve());
  });
}
interface Effects {
  readonly operations: readonly { readonly command: string; readonly result: unknown }[];
  readonly audit: readonly {
    readonly outcome: string;
    readonly command: string;
    readonly operation_id: string;
  }[];
}
export async function effects(w: TimeWorld, operationId: string): Promise<Effects> {
  const operations = await w.db.admin.execute<{
    readonly command: string;
    readonly result: unknown;
  }>(
    'select command,result from public.operations where business_id=$1 and actor_id=$2 and operation_id=$3',
    [w.alpha, w.taskOnly.actorId, operationId],
  );
  const audit = await w.db.admin.execute<{
    readonly outcome: string;
    readonly command: string;
    readonly operation_id: string;
  }>(
    'select outcome,command,operation_id from public.audit_events where business_id=$1 and actor_id=$2 and operation_id=$3 order by seq',
    [w.alpha, w.taskOnly.actorId, operationId],
  );
  return { operations: [...operations], audit: [...audit] };
}
export function storageCopy(): StorageLike {
  const slots = new Map<string, string>();
  return {
    getItem: (key: string) => slots.get(key) ?? null,
    setItem: (key: string, value: string) => {
      slots.set(key, value);
    },
    removeItem: (key: string) => {
      slots.delete(key);
    },
  };
}
type BoardCommand = Extract<
  CommandName,
  'task.update' | 'task.set_stage' | 'task.complete' | 'task.reopen'
>;
/** Resolve only this proof's four actual client routes; the canonical envelope still dispatches. */
function commandOf(path: string): BoardCommand {
  const route = path.split('/').slice(-2).join('.');
  switch (route) {
    case 'task.update':
      return 'task.update';
    case 'task.set_stage':
      return 'task.set_stage';
    case 'task.complete':
      return 'task.complete';
    case 'task.reopen':
      return 'task.reopen';
    default:
      throw new Error('Unexpected recovery transport route');
  }
}
interface RollbackCheck {
  readonly command: BoardCommand;
  readonly operationId: string;
  readonly recordId: string;
  readonly revision: number;
}
async function assertTransactionEvidence(
  tx: TenantQuery,
  session: Session,
  route: BoardCommand,
  body: Readonly<Record<string, unknown>>,
  answer: Awaited<ReturnType<typeof runCommand>>,
): Promise<void> {
  const register = await tx.query<{
    readonly command: string;
    readonly outcome: string;
    readonly result: unknown;
  }>(
    'select command,outcome,result from public.operations where business_id=$1 and actor_id=$2 and operation_id=$3',
    [tx.businessId, session.actorId, body['operationId']],
  );
  expect([...register]).toStrictEqual([{ command: route, outcome: 'applied', result: answer }]);
  const audit = await tx.query<{
    readonly command: string;
    readonly outcome: string;
    readonly operation_id: string;
    readonly subject_record_id: string;
  }>(
    'select command,outcome,operation_id,subject_record_id from public.audit_events where business_id=$1 and actor_id=$2 and operation_id=$3 order by seq',
    [tx.businessId, session.actorId, body['operationId']],
  );
  expect([...audit]).toStrictEqual([
    {
      command: route,
      outcome: 'applied',
      operation_id: body['operationId'],
      subject_record_id: body['recordId'],
    },
  ]);
}
async function proveBeforeRollback(
  tx: TenantQuery,
  session: Session,
  presented: VerifiedSubject,
  route: BoardCommand,
  body: Readonly<Record<string, unknown>>,
): Promise<RollbackCheck> {
  // The selected rollback case is a title update. These observations use
  // the handler's owning tx, not a second connection that cannot see it.
  expect(route).toBe('task.update');
  const before = await tx.query<{ readonly title: string; readonly revision: string }>(
    'select txt_4 as title, revision::text as revision from public.records where business_id=$1 and id=$2',
    [tx.businessId, body['recordId']],
  );
  expect(before).toHaveLength(1);
  expect(before[0]?.title).toBe('Canonical board recovery');
  expect(Number(before[0]?.revision)).toBe(body['expectedRevision']);
  const answer = await runCommand(tx, session, 'api', { ...body, command: route }, presented);
  if (isCommandRefusal(answer)) throw new Error(`Rollback precondition refused: ${answer.code}`);
  if (typeof body['operationId'] !== 'string' || typeof body['recordId'] !== 'string')
    throw new Error('Rollback identity missing');
  const revision = Number(before[0]?.revision) + 1;
  expect(answer).toMatchObject({ command: route, recordId: body['recordId'], revision });
  const after = await tx.query<{
    readonly title: string;
    readonly data: Readonly<Record<string, unknown>>;
    readonly revision: string;
  }>(
    'select txt_4 as title, data, revision::text as revision from public.records where business_id=$1 and id=$2',
    [tx.businessId, body['recordId']],
  );
  expect(after).toHaveLength(1);
  expect(after[0]?.title).toBe('Submitted canonical board edit');
  expect(after[0]?.data['title']).toBe('Submitted canonical board edit');
  expect(Number(after[0]?.revision)).toBe(revision);
  await assertTransactionEvidence(tx, session, route, body, answer);
  return { command: route, operationId: body['operationId'], recordId: body['recordId'], revision };
}
interface BoardWrite {
  readonly command: BoardCommand;
  readonly body: Readonly<Record<string, unknown>>;
}
interface Delivery {
  readonly writes: readonly BoardWrite[];
  readonly client: OperationsClient;
  readonly storage: StorageLike;
  readonly custody: BoardEditCustody;
  readonly rollbackChecks: readonly RollbackCheck[];
  copy(): BoardEditCustody;
}
function restoredCustody(
  w: TimeWorld,
  client: OperationsClient,
  storage: StorageLike,
): BoardEditCustody {
  const copied = storageCopy();
  const raw = storage.getItem(BOARD_EDIT_KEY);
  expect(raw).not.toBeNull();
  copied.setItem(BOARD_EDIT_KEY, raw ?? '');
  return new BoardEditCustody(client, `${w.alpha}:${w.taskOnly.personId}`, copied);
}
async function deliberatelyRolledBack(
  w: TimeWorld,
  route: BoardCommand,
  body: Readonly<Record<string, unknown>>,
  rollbackChecks: RollbackCheck[],
): Promise<never> {
  await withSession(w.db.app, w.alpha, w.taskOnly.presented, async (tx, session) => {
    const checked = await proveBeforeRollback(tx, session, w.taskOnly.presented, route, body);
    // Appended only after every tx-local assertion passes. An assertion
    // swallowed as an unknown transport result leaves this marker absent.
    rollbackChecks.push(checked);
    throw new Error('Deliberate transaction rollback after proven canonical success');
  });
  throw new Error('Rollback did not raise');
}
/** Only transport loss is simulated; every reached mutation uses the canonical authenticated envelope. */
export function delivery(w: TimeWorld, loss: 'stored' | 'unreached' | 'rollback'): Delivery {
  const writes: BoardWrite[] = [];
  const rollbackChecks: RollbackCheck[] = [];
  let first = true;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const route = commandOf(new URL(String(input), 'http://synthetic.test').pathname);
    const body: Record<string, unknown> = JSON.parse(String(init?.body));
    writes.push({ command: route, body });
    if (first && loss === 'unreached') {
      first = false;
      throw new TypeError('Never forwarded');
    }
    if (first && loss === 'rollback') {
      first = false;
      await deliberatelyRolledBack(w, route, body, rollbackChecks);
    }
    const answer = await w.as(w.alpha, w.taskOnly, { ...body, command: route });
    if (first && loss === 'stored') {
      first = false;
      throw new TypeError('Committed canonical response lost');
    }
    return new Response(JSON.stringify(answer), {
      status: isCommandRefusal(answer) ? 403 : 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new OperationsClient({
    origin: '',
    businessKey: w.alpha,
    signedIn: true,
    fetch,
    newOperationId: randomUUID,
  });
  const storage = storageCopy();
  const custody = new BoardEditCustody(client, `${w.alpha}:${w.taskOnly.personId}`, storage);
  return {
    writes,
    client,
    storage,
    custody,
    rollbackChecks,
    copy: () => restoredCustody(w, client, storage),
  };
}
