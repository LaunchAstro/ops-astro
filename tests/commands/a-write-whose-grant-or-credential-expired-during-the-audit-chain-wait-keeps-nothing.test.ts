// SPDX-License-Identifier: AGPL-3.0-only
//
// The envelope asks the door's questions again after the command's last wait,
// the audit chain's included. A fixture holds the business's audit-chain lock,
// so the write's audit insert waits on it; while it waits, the grant or the
// agent credential the write stands on expires; then the fixture lets go. A
// revocation cannot commit in that wait (the access lock is held), but time
// passes, and a write the door would now refuse keeps nothing: the task, the
// operation and the applied audit are as they were.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeCredentialCommand } from '../../packages/core-commands/src/commands/credential-envelope.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import type { ReadResult } from '../../packages/core-commands/src/reads/requests.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { enrol, grantTo, installSpine, WHOLE_BUSINESS, type Member } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

let db: FreshDatabase;
let alpha: string;
let ada: Member;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'commit_reask' });
  alpha = await insertBusiness(db.app, 'alpha');
  await installSpine(db.app, alpha);
  ada = await enrol(db.app, alpha, 'Ada Lane');
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, ada, 'manage', WHOLE_BUSINESS, true);
    await grantTo(tx, ada, 'write', WHOLE_BUSINESS, true);
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const codeOf = (answer: CommandResult | ReadResult): string =>
  isCommandRefusal(answer) ? answer.code : 'applied';

const send = async (
  who: Member,
  body: Readonly<Record<string, unknown>>,
  database: Database = db.app,
): Promise<CommandResult> =>
  await executeCommand(database, alpha, who.presented, 'api', body as never);

/** A task Ada creates, with its revision. */
async function aTask(title: string): Promise<{ readonly id: string; readonly revision: number }> {
  const made = await send(ada, {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title },
  });
  if (isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
  return { id: String(made.recordId), revision: Number(made.revision) };
}

const rename = (task: { readonly id: string; readonly revision: number }, title: string) => ({
  command: 'task.update',
  operationId: randomUUID(),
  recordId: task.id,
  expectedRevision: task.revision,
  fields: { title },
});

/** What the operation left, and the task's revision. */
async function kept(operationId: string, taskId: string): Promise<unknown> {
  const [row] = await db.admin.execute(
    `select (select count(*)::int from public.operations
              where business_id = $1 and operation_id = $2) as operations,
            (select count(*)::int from public.audit_events
              where business_id = $1 and operation_id = $2 and outcome = 'applied') as applied,
            (select revision::int from public.records
              where business_id = $1 and id = $3::uuid) as revision`,
    [alpha, operationId, taskId],
  );
  return row;
}

/** Waits until the database's clock is past `table`'s row `id` expiry. */
async function pastExpiry(table: 'grants' | 'agent_credentials', id: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const [row] = await db.admin.execute<{ readonly past: boolean }>(
      `select expires_at < clock_timestamp() as past from public.${table} where id = $1`,
      [id],
    );
    if (row?.past === true) return;
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(`${table} ${id} never expired`);
}

/** `write` sent on its own connection while the audit chain is held; `expired` waits it out. */
async function waitingOnTheChain(
  write: (database: Database) => Promise<CommandResult | ReadResult>,
  expired: () => Promise<void>,
): Promise<CommandResult | ReadResult> {
  const writer = connect(db.appUrl);
  try {
    const chain = await hold(db.appUrl, alpha, async (tx) => {
      await tx.query('select pg_advisory_xact_lock(hashtextextended($1::text, 0))', [alpha]);
    });
    let writing: Promise<CommandResult | ReadResult> | undefined;
    try {
      writing = write(writer);
      await waitingOn(db.admin, 'advisory', 'audit_events');
      await expired();
    } finally {
      await chain.letGo();
    }
    return await writing;
  } finally {
    await writer.close();
  }
}

it.skipIf(serverUrl === undefined)(
  'a write whose only grant expired while its audit waited on the chain is refused and keeps nothing',
  async () => {
    const task = await aTask('before the wait');
    const gus = await enrol(db.app, alpha, 'Gus Reed');
    const grantId = await db.app.withBusiness(
      alpha,
      async (tx) => await grantTo(tx, gus, 'write', WHOLE_BUSINESS),
    );
    await db.admin.execute(
      `update public.grants set expires_at = clock_timestamp() + interval '2 seconds' where id = $1`,
      [grantId],
    );
    const late = rename(task, 'after the wait');
    const answer = await waitingOnTheChain(
      async (writer) => await send(gus, late, writer),
      async () => await pastExpiry('grants', grantId),
    );
    expect({ answer: codeOf(answer), kept: await kept(late.operationId, task.id) }).toStrictEqual({
      answer: 'SCOPE_NOT_GRANTED',
      kept: { operations: 0, applied: 0, revision: task.revision },
    });
  },
);

it.skipIf(serverUrl === undefined)(
  'a write whose grant is still live when its audit waited on the chain applies',
  async () => {
    const task = await aTask('before the wait');
    const body = rename(task, 'after the wait');
    const answer = await waitingOnTheChain(
      async (writer) => await send(ada, body, writer),
      async () => await Promise.resolve(),
    );
    expect({ answer: codeOf(answer), kept: await kept(body.operationId, task.id) }).toStrictEqual({
      answer: 'applied',
      kept: { operations: 1, applied: 1, revision: task.revision + 1 },
    });
  },
);

it.skipIf(serverUrl === undefined)(
  'an agent credential that expired while its write waited on the audit chain is refused and keeps nothing',
  async () => {
    const task = await aTask('before the wait');
    await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, ada, 'write', WHOLE_BUSINESS, false, 'credential');
    });
    const issued = await send(ada, {
      command: 'credential.issue',
      operationId: randomUUID(),
      scope: [{ collection: 'task', action: 'write' }],
      purpose: 'a write that waits on the audit chain',
      // Written once: issued to expire seconds from now, which the wait outlasts.
      expiresAt: new Date(Date.now() + 3_000).toISOString(),
    });
    if (isCommandRefusal(issued)) throw new Error(`credential.issue refused ${issued.code}`);
    const credential = issued.detail['credential'];
    if (typeof credential !== 'string') throw new Error('credential.issue returned no secret');
    const late = rename(task, 'after the wait');
    const answer = await waitingOnTheChain(
      async (writer) =>
        await executeCredentialCommand(
          writer,
          alpha as never,
          { credential, now: new Date() },
          late as never,
        ),
      async () => await pastExpiry('agent_credentials', String(issued.recordId)),
    );
    expect({ answer: codeOf(answer), kept: await kept(late.operationId, task.id) }).toStrictEqual({
      answer: 'DELEGATION_NOT_LIVE',
      kept: { operations: 0, applied: 0, revision: task.revision },
    });
  },
);
