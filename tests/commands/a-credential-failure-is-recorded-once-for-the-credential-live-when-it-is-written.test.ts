// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent credential's command that raised past its one retry has its
// attempt recorded again in a transaction of its own (`credential-failure.ts`):
// the credential's standing is read under the shared access lock and the row's
// share lock, and a `failed` event is written for its agent actor while the
// credential is live, with no message.
//
// Two connections: a revocation committed while the record waits on the
// access lock leaves nothing recorded, as promised; a revocation sent once the
// record has read the credential waits for the record to commit. A crash: the
// record's own insert raises, and the caller still sees the original fault.
// A retry: the same operation sent again once the fault has gone applies once.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, expect, it as vitestIt, vi } from 'vitest';
import { executeCredentialCommand } from '../../packages/core-commands/src/commands/credential-envelope.ts';
import { recordCredentialFailure } from '../../packages/core-commands/src/commands/credential-failure.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  lockAgentCredential,
  revokeAgentCredential,
} from '../../packages/core-records/src/authority/agent-credentials.ts';
import {
  advisoryLock,
  connect,
  type Database,
} from '../../packages/core-records/src/tenancy/database.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import {
  detailOf,
  issueAs,
  issueBody,
  issuerIn,
  type Issuer,
} from '../authority/agent-credential-issuer.ts';
import {
  failingStatements,
  heldOpen,
  insertsInto,
  StatementFailed,
} from '../support/failing-statements.ts';
import { waitingOn } from '../support/lock-waits.ts';

const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

let world: World;

beforeAll(async () => {
  if (serverUrl !== undefined) world = await createWorld('credfailurerace');
}, 120_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (serverUrl !== undefined) await world.close();
});

interface Issued {
  readonly issuer: Issuer;
  readonly credentialId: string;
  readonly agentActorId: string;
  readonly secret: string;
}

async function issued(): Promise<Issued> {
  const issuer = await issuerIn(world);
  const detail = detailOf(await issueAs(world, issuer, issueBody()));
  return {
    issuer,
    credentialId: String(detail['credentialId']),
    agentActorId: String(detail['agentActorId']),
    secret: String(detail['credential']),
  };
}

const createTask = (operationId: string) =>
  ({ command: 'task.create', operationId, fields: { title: 'written by the agent' } }) as const;

const sendAs = async (database: Database, secret: string, operationId: string): Promise<unknown> =>
  await executeCredentialCommand(
    database,
    world.alpha,
    { credential: secret, now: new Date() },
    createTask(operationId),
  );

/** The operation's audit events: who each names and its outcome, in chain order. */
const trailOf = async (operationId: string): Promise<readonly unknown[]> =>
  await world.db.admin.execute(
    `select actor_id, outcome from public.audit_events where operation_id = $1 order by seq`,
    [operationId],
  );

it('a failed attempt whose credential is revoked while its record waits on the access lock is not recorded', async () => {
  const { issuer, credentialId, secret } = await issued();
  const operationId = randomUUID();
  const fixture = connect(world.db.appUrl);
  const recorder = connect(world.db.appUrl);
  try {
    let recording: Promise<void> | undefined;
    await fixture.withBusiness(world.alpha, async (tx) => {
      await advisoryLock(tx, `access:${tx.businessId}`);
      recording = recordCredentialFailure(
        recorder,
        world.alpha,
        { credential: secret, now: new Date() },
        createTask(operationId),
        new Error('the attempt failed'),
      );
      await waitingOn(world.db.admin, 'advisory', 'pg_advisory_xact_lock');
      const held = await lockAgentCredential(tx, credentialId);
      if (held === undefined) throw new Error('the issued credential is not there');
      await revokeAgentCredential(tx, held, issuer.actorId);
    });
    await expect(recording).resolves.toBeUndefined();
    expect(await trailOf(operationId)).toEqual([]);
  } finally {
    await Promise.all([fixture.close(), recorder.close()]);
  }
}, 60_000);

it('a revocation sent once a failed attempt has read its credential waits for the record to commit', async () => {
  const { issuer, credentialId, agentActorId, secret } = await issued();
  const operationId = randomUUID();
  const base = connect(world.db.appUrl);
  const held = heldOpen(base);
  try {
    const recording = recordCredentialFailure(
      held.database,
      world.alpha,
      { credential: secret, now: new Date() },
      createTask(operationId),
      new Error('the attempt failed'),
    );
    await held.returned;
    const revoking = executeCommand(world.db.app, world.alpha, issuer.presented, 'api', {
      command: 'credential.revoke',
      operationId: randomUUID(),
      credentialId,
    });
    const first = await Promise.race([
      revoking.then(() => 'revoked' as const),
      delay(1_500).then(() => 'waiting' as const),
    ]);
    held.commit();
    await recording;
    const revoked = await revoking;
    expect({
      whileTheRecordWasOpen: first,
      revoked: isCommandRefusal(revoked) ? revoked.code : 'applied',
      trail: await trailOf(operationId),
    }).toEqual({
      whileTheRecordWasOpen: 'waiting',
      revoked: 'applied',
      trail: [{ actor_id: agentActorId, outcome: 'failed' }],
    });
  } finally {
    held.commit();
    await base.close();
  }
}, 60_000);

it('a failed attempt whose own record raises still hands the caller the original fault', async () => {
  const { secret } = await issued();
  const operationId = randomUUID();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => null);
  // Every task insert raises, and so does every audit insert: the record's own.
  const dying = failingStatements(
    world.db.app,
    (text, parameters) =>
      insertsInto('records')(text, parameters) || insertsInto('audit_events')(text, parameters),
  );
  await expect(sendAs(dying, secret, operationId)).rejects.toThrow(
    /insert into (?:public\.)?records/u,
  );
  const warned = warn.mock.calls.map((call) => String(call[0]));
  expect({ trail: await trailOf(operationId), warnings: warned.length }).toEqual({
    trail: [],
    warnings: 1,
  });
  // A log names the fault, never its message, which may quote a value.
  expect(warned[0]).not.toContain('the statement failed');
}, 60_000);

it('a failed credential attempt sent again once the fault is gone creates one task', async () => {
  const { secret, agentActorId } = await issued();
  const operationId = randomUUID();
  const dying = failingStatements(world.db.app, insertsInto('records'));
  await expect(sendAs(dying, secret, operationId)).rejects.toBeInstanceOf(StatementFailed);
  const first = await sendAs(world.db.app, secret, operationId);
  expect(isCommandRefusal(first as object), JSON.stringify(first)).toBe(false);
  // Once more, as after a lost response.
  const again = await sendAs(world.db.app, secret, operationId);
  expect({ again, trail: (await trailOf(operationId)).length }).toEqual({ again: first, trail: 3 });
  expect(await trailOf(operationId)).toEqual([
    { actor_id: agentActorId, outcome: 'failed' },
    { actor_id: agentActorId, outcome: 'applied' },
    { actor_id: agentActorId, outcome: 'replayed' },
  ]);
}, 60_000);
