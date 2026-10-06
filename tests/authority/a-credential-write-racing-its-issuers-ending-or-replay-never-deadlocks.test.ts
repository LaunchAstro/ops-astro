// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent credential's write and a change that locks that credential take
// the business's access lock before the credential row, both of them: the
// credential call shared, `access.end` and the issuer's replay of
// `credential.issue` exclusive. So the two serialise and never deadlock.
//
// Each case holds the agent's operation door (`operation:<business>:<agent
// actor>:<digest>`) on a fixture connection, so the agent's `task.create`
// stops after the credential is resolved and before its command runs. The
// other change starts on a connection of its own and waits behind the agent
// (`pg_blocking_pids` names it). The door is let go, both finish, and the
// database's deadlock count has not moved: the envelopes retry a deadlock
// once, so the answers alone would hide one.

import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it as vitestIt } from 'vitest';
import { executeCredentialCommand } from '../../packages/core-commands/src/commands/credential-envelope.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import type { ReadResult } from '../../packages/core-commands/src/reads/requests.ts';
import { advisoryLock, connect } from '../../packages/core-records/src/tenancy/database.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { enrol, grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';

const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

const DAY_MS = 24 * 60 * 60 * 1000;

interface Issued {
  readonly issuer: Member;
  readonly operationId: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly credential: string;
  readonly credentialId: string;
  readonly agentActorId: string;
}

const detailOf = (answer: unknown): Record<string, unknown> =>
  (answer as { readonly detail: Record<string, unknown> }).detail;

/** A person with task read and write who issues one credential for both. */
async function issued(world: World): Promise<Issued> {
  const issuer = await enrol(world.db.app, world.alpha, `issuer-${randomUUID().slice(0, 6)}`);
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await grantTo(tx, issuer, 'read', WHOLE_BUSINESS);
    await grantTo(tx, issuer, 'write', WHOLE_BUSINESS);
    await grantTo(tx, issuer, 'write', WHOLE_BUSINESS, false, 'credential');
  });
  const operationId = randomUUID();
  const body = {
    scope: [
      { collection: 'task', action: 'read' },
      { collection: 'task', action: 'write' },
    ],
    expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    purpose: 'the command line on a laptop',
  };
  const answer = await executeCommand(world.db.app, world.alpha, issuer.presented, 'api', {
    command: 'credential.issue',
    operationId,
    ...body,
  });
  expect(isCommandRefusal(answer), JSON.stringify(answer)).toBe(false);
  const detail = detailOf(answer);
  return {
    issuer,
    operationId,
    body,
    credential: String(detail['credential']),
    credentialId: String(detail['credentialId']),
    agentActorId: String(detail['agentActorId']),
  };
}

/** Deadlocks this database has recorded, read in a transaction of its own. */
const deadlocks = async (world: World): Promise<number> => {
  const rows = await world.db.admin.execute<{ readonly n: string }>(
    'select deadlocks::text as n from pg_stat_database where datname = current_database()',
  );
  return Number(rows[0]?.n);
};

/**
 * The deadlock count once the racing backends have gone: each flushes its
 * counts as it exits, so it is read until it moves past `before` or a few
 * seconds pass.
 */
async function deadlocksAfter(world: World, before: number): Promise<number> {
  const until = Date.now() + 3000;
  let now = await deadlocks(world);
  while (now === before && Date.now() < until) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await delay(50);
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    now = await deadlocks(world);
  }
  return now;
}

/**
 * Waits until a backend waits on `holder`, and another waits on that one:
 * the agent at its door, and the racing change behind the agent.
 */
async function behindTheAgent(world: World, holder: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const rows = await world.db.admin.execute<{ readonly agent: number }>(
      `select a.pid as agent
         from pg_stat_activity a join pg_stat_activity o
           on a.pid = any(pg_blocking_pids(o.pid))
        where a.datname = current_database() and $1::int = any(pg_blocking_pids(a.pid))`,
      [holder],
    );
    if (rows.length > 0) return;
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await delay(10);
  }
  throw new Error('the change never waited behind the agent');
}

const noop = (): void => undefined;

/** The agent's operation door for `operationId`, as the envelope spells it. */
const doorOf = (world: World, agentActorId: string, operationId: string): string =>
  `operation:${world.alpha.toLowerCase()}:${agentActorId}:${createHash('sha256').update(operationId).digest('hex')}`;

/** A fixture transaction on its own connection holding `door` until it is let go. */
async function holdDoor(
  world: World,
  door: string,
): Promise<{ readonly pid: number; readonly letGo: () => Promise<void> }> {
  const db = connect(world.db.appUrl, { max: 1 });
  let holding: (pid: number) => void = noop;
  const held = new Promise<number>((resolve) => {
    holding = resolve;
  });
  let release = noop;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = db.withBusiness(world.alpha, async (tx) => {
    const [row] = await tx.query<{ readonly pid: number }>('select pg_backend_pid() as pid');
    await advisoryLock(tx, door);
    holding(Number(row?.pid));
    await released;
  });
  const pid = await Promise.race([held, done.then(() => -1)]);
  let gone: Promise<void> | undefined;
  return {
    pid,
    letGo: async () => {
      release();
      gone ??= done.finally(async () => await db.close());
      await gone;
    },
  };
}

/**
 * The agent's `task.create` held at its door while `other` runs on its own
 * connection: both answers, and the deadlocks the race added.
 */
async function race(
  world: World,
  credential: Issued,
  other: (database: ReturnType<typeof connect>) => Promise<CommandResult>,
): Promise<{
  readonly agent: CommandResult | ReadResult;
  readonly other: CommandResult;
  readonly deadlocks: number;
}> {
  const before = await deadlocks(world);
  const agentDb = connect(world.db.appUrl, { max: 1 });
  const otherDb = connect(world.db.appUrl, { max: 1 });
  const operationId = randomUUID();
  const door = await holdDoor(world, doorOf(world, credential.agentActorId, operationId));
  let answers: { readonly agent: CommandResult | ReadResult; readonly other: CommandResult };
  try {
    const agent = executeCredentialCommand(
      agentDb,
      world.alpha,
      { credential: credential.credential, now: new Date() },
      { command: 'task.create', operationId, title: 'written by the agent' },
    );
    const otherAnswer = other(otherDb);
    await behindTheAgent(world, door.pid);
    await door.letGo();
    answers = { agent: await agent, other: await otherAnswer };
  } finally {
    await door.letGo();
    // Closed before the count is read: a backend flushes its counts as it exits.
    await Promise.all([agentDb.close(), otherDb.close()]);
  }
  return { ...answers, deadlocks: (await deadlocksAfter(world, before)) - before };
}

const revokedAt = async (world: World, credentialId: string): Promise<unknown> => {
  const rows = await world.db.admin.execute<{ readonly revoked_at: unknown }>(
    'select revoked_at from public.agent_credentials where id = $1',
    [credentialId],
  );
  return rows[0]?.revoked_at;
};

it('an agent credential write and an ending of its issuer access serialise without a deadlock', async () => {
  const world = await createWorld('credlockend');
  try {
    const credential = await issued(world);
    const raced = await race(
      world,
      credential,
      async (database) =>
        await executeCommand(database, world.alpha, world.ada.presented, 'api', {
          command: 'access.end',
          operationId: randomUUID(),
          holderId: credential.issuer.personId,
        }),
    );
    expect(raced.deadlocks, 'deadlocks the race added').toBe(0);
    expect(isCommandRefusal(raced.agent), JSON.stringify(raced.agent)).toBe(false);
    expect(isCommandRefusal(raced.other), JSON.stringify(raced.other)).toBe(false);
    expect(detailOf(raced.other)['credentialsRevoked']).toBe(1);
    expect(await revokedAt(world, credential.credentialId)).not.toBeNull();
  } finally {
    await world.close();
  }
});

it('an agent credential write and its issuer replay of the issue serialise without a deadlock', async () => {
  const world = await createWorld('credlockreplay');
  try {
    const credential = await issued(world);
    const raced = await race(
      world,
      credential,
      async (database) =>
        await executeCommand(database, world.alpha, credential.issuer.presented, 'api', {
          command: 'credential.issue',
          operationId: credential.operationId,
          ...credential.body,
        }),
    );
    expect(raced.deadlocks, 'deadlocks the race added').toBe(0);
    expect(isCommandRefusal(raced.agent), JSON.stringify(raced.agent)).toBe(false);
    expect(isCommandRefusal(raced.other), JSON.stringify(raced.other)).toBe(false);
    expect(detailOf(raced.other)['credential']).toBe(credential.credential);
  } finally {
    await world.close();
  }
});
