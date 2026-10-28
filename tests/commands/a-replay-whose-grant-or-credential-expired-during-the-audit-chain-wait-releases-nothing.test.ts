// SPDX-License-Identifier: AGPL-3.0-only
//
// A replay is a call, so its stored success goes out only to a caller the door
// would let in now, judged after the replay's last wait (#2307). A fixture
// holds the business's audit-chain lock, so the replay's `replayed` audit
// insert waits on it; while it waits, the grant, credential or delegation the
// caller stands on expires; then the fixture lets go. The replay is refused
// as a fresh call would be, the `replayed` event is taken back, and the
// operation and its record are as the first call left them.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { executeCredentialCommand } from '../../packages/core-commands/src/commands/credential-envelope.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { agentWorld, type AgentWorld } from './agent-fixture.ts';
import { enrol, grantTo, WHOLE_BUSINESS, type Member } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

let world: AgentWorld;
let ada: Member;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await agentWorld('replay_reask', 'replay-reask');
  ada = await enrol(world.db.app, world.business, 'Ada Lane');
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, ada, 'manage', WHOLE_BUSINESS, true);
    await grantTo(tx, ada, 'write', WHOLE_BUSINESS, true);
  });
}, 120_000);

afterAll(async () => {
  await world?.drop();
});

const codeOf = (answer: CommandResult): string =>
  isCommandRefusal(answer) ? answer.code : 'applied';

type Body = Readonly<Record<string, unknown>>;

const send = async (who: Member, body: Body, database: Database = world.db.app) =>
  await executeCommand(database, world.business, who.presented, 'api', body as never);

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

/** The operation's register rows, its audit events in order, and the record's revision. */
async function kept(operationId: string, recordId: string): Promise<unknown> {
  const [row] = await world.db.admin.execute<{
    readonly operations: number;
    readonly revision: number;
  }>(
    `select (select count(*)::int from public.operations
              where business_id = $1 and operation_id = $2) as operations,
            (select revision::int from public.records
              where business_id = $1 and id = $3::uuid) as revision`,
    [world.business, operationId, recordId],
  );
  const audit = (await world.auditFor(operationId)).map(
    ({ outcome, code }) => `${outcome}:${code ?? ''}`,
  );
  return { ...row, audit };
}

/** Waits until the database's clock is past `table`'s row `id` expiry. */
async function pastExpiry(
  table: 'grants' | 'agent_credentials' | 'delegations',
  id: string,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const [row] = await world.db.admin.execute<{ readonly past: boolean }>(
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

/** `replay` sent on its own connection while the audit chain is held; `expired` waits it out. */
async function waitingOnTheChain(
  replay: (database: Database) => Promise<CommandResult>,
  expired: () => Promise<void>,
): Promise<CommandResult> {
  const replayer = connect(world.db.appUrl);
  try {
    const chain = await hold(world.db.appUrl, world.business, async (tx) => {
      await tx.query('select pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
        world.business,
      ]);
    });
    let replaying: Promise<CommandResult> | undefined;
    try {
      replaying = replay(replayer);
      await waitingOn(world.db.admin, 'advisory', 'audit_events');
      await expired();
    } finally {
      await chain.letGo();
    }
    return await replaying;
  } finally {
    await replayer.close();
  }
}

it.skipIf(serverUrl === undefined)(
  'a replay whose only grant expired while its audit waited on the chain is refused and releases nothing',
  async () => {
    const task = await aTask('before the replay');
    const gus = await enrol(world.db.app, world.business, 'Gus Reed');
    const grantId = await world.db.app.withBusiness(
      world.business,
      async (tx) => await grantTo(tx, gus, 'write', WHOLE_BUSINESS),
    );
    const body = rename(task, 'renamed once');
    expect(codeOf(await send(gus, body))).toBe('applied');
    await world.db.admin.execute(
      `update public.grants set expires_at = clock_timestamp() + interval '2 seconds' where id = $1`,
      [grantId],
    );
    const answer = await waitingOnTheChain(
      async (replayer) => await send(gus, body, replayer),
      async () => await pastExpiry('grants', grantId),
    );
    expect({ answer: codeOf(answer), kept: await kept(body.operationId, task.id) }).toStrictEqual({
      answer: 'SCOPE_NOT_GRANTED',
      kept: {
        operations: 1,
        audit: ['applied:', 'refused:SCOPE_NOT_GRANTED'],
        revision: task.revision + 1,
      },
    });
  },
);

it.skipIf(serverUrl === undefined)(
  'a replay whose grant is still live when its audit waited on the chain returns the stored success',
  async () => {
    const task = await aTask('before the replay');
    const body = rename(task, 'renamed once');
    const first = await send(ada, body);
    expect(codeOf(first)).toBe('applied');
    const answer = await waitingOnTheChain(
      async (replayer) => await send(ada, body, replayer),
      async () => await Promise.resolve(),
    );
    expect({ answer, kept: await kept(body.operationId, task.id) }).toStrictEqual({
      answer: first,
      kept: { operations: 1, audit: ['applied:', 'replayed:'], revision: task.revision + 1 },
    });
  },
);

it.skipIf(serverUrl === undefined)(
  'an agent credential that expired while its replay waited on the audit chain is refused and releases nothing',
  async () => {
    const task = await aTask('before the replay');
    await world.db.app.withBusiness(world.business, async (tx) => {
      await grantTo(tx, ada, 'write', WHOLE_BUSINESS, false, 'credential');
    });
    const issued = await send(ada, {
      command: 'credential.issue',
      operationId: randomUUID(),
      scope: [{ collection: 'task', action: 'write' }],
      purpose: 'a replay that waits on the audit chain',
      // Written once: issued to expire seconds from now, which the wait outlasts.
      expiresAt: new Date(Date.now() + 4_000).toISOString(),
    });
    if (isCommandRefusal(issued)) throw new Error(`credential.issue refused ${issued.code}`);
    const credential = issued.detail['credential'];
    if (typeof credential !== 'string') throw new Error('credential.issue returned no secret');
    const body = rename(task, 'renamed once');
    const asCredential = async (database: Database): Promise<CommandResult> =>
      // A write: the credential entry answers it as a command.
      (await executeCredentialCommand(
        database,
        world.business,
        { credential, now: new Date() },
        body as never,
      )) as CommandResult;
    expect(codeOf(await asCredential(world.db.app))).toBe('applied');
    const answer = await waitingOnTheChain(
      asCredential,
      async () => await pastExpiry('agent_credentials', String(issued.recordId)),
    );
    expect({ answer: codeOf(answer), kept: await kept(body.operationId, task.id) }).toStrictEqual({
      answer: 'DELEGATION_NOT_LIVE',
      kept: {
        operations: 1,
        audit: ['applied:', 'refused:DELEGATION_NOT_LIVE'],
        revision: task.revision + 1,
      },
    });
  },
);

it.skipIf(serverUrl === undefined)(
  'an agent delegation that expired while its replay waited on the audit chain is refused and releases nothing',
  async () => {
    const decider = await world.decider('commenter');
    const picked = await world.pickUp(decider, 'a task commented on, then replayed');
    const comment = {
      command: 'task.comment',
      operationId: randomUUID(),
      recordId: picked.taskId,
      body: 'a note for the team',
      audience: 'internal',
    };
    expect(codeOf(await world.asAgent(comment, picked.credential))).toBe('applied');
    const delegationId = String(picked.detail['delegationId']);
    await world.db.admin.execute(
      `update public.delegations set expires_at = clock_timestamp() + interval '2 seconds'
        where business_id = $1 and id = $2`,
      [world.business, delegationId],
    );
    const answer = await waitingOnTheChain(
      async (replayer) =>
        (await executeAgentCommand(
          replayer,
          world.business,
          { provider: 'supabase', subject: world.agentSubject() },
          picked.credential,
          comment as never,
        )) as CommandResult,
      async () => await pastExpiry('delegations', delegationId),
    );
    expect({
      answer: codeOf(answer),
      audit: await world.auditFor(comment.operationId),
    }).toStrictEqual({
      answer: 'DELEGATION_NOT_LIVE',
      audit: [
        { outcome: 'applied', code: null },
        { outcome: 'refused', code: 'DELEGATION_NOT_LIVE' },
      ],
    });
  },
);
