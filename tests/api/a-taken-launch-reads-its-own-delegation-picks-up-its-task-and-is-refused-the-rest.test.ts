// SPDX-License-Identifier: AGPL-3.0-only
//
// The delegation the owner's Launch mints on his task, once his agent has
// taken the launch (#2178): the worker under its credential reads which task
// it names (`session.capabilities`) and the task, and picks up the owner's
// accepted plan on that task. Every other operation under it is refused
// `DELEGATION_EXCLUDES_OPERATION` and writes nothing; the plan on another task
// is not picked up; in another business the credential reaches nothing. The
// owner's correction is stored under the pickup's own credential, which the
// exclusion never held, and refused under the launch's.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { insertBusiness, insertLogin } from '../identity/fixture.ts';
import { enrol, installSpine } from '../commands/fixture.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { SYNTHETIC_STEP } from '../../apps/worker/worker.ts';
import { applied, ownerLaunchWorld, type OwnerLaunchWorld } from './owner-launch-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'api/a-taken-launch-reads-its-own-delegation: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

/** What the worker sends under a taken launch's credential, and the server admits. */
const ADMITTED: ReadonlySet<string> = new Set([
  'task.read',
  'session.capabilities',
  'task.queue',
  'task.pickup',
]);

/** Each operand the agent entry reads before the delegation, well formed, so the answer is the exclusion. */
const OPERANDS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'task.handback': { leaseId: randomUUID(), fence: 1, outcome: 'completed' },
  'model.call': { leaseId: randomUUID(), fence: 1, operation: 'model.replay_compose', fields: [] },
  'run.delegate_child': {
    leaseId: randomUUID(),
    fence: 1,
    helperActorId: randomUUID(),
    purpose: 'helper',
    collections: ['task'],
    actions: ['read'],
    expiresInSeconds: 60,
  },
  'run.child_handback': { outcome: 'completed' },
};

const correction = (taskId: string, page = '/') => ({
  operationId: randomUUID(),
  taskId,
  page,
  word: 'teh',
  replacement: 'the',
});

/**
 * What each refusal is: a take presenting any credential is refused before the
 * launch is looked at, intake has its own exclusion, and a helper's handback
 * finds no live child of its own in a launch's delegation.
 */
const refusalOf = (name: string): { readonly status: number; readonly code: string } =>
  name === 'task.take_launch'
    ? { status: 403, code: 'SCOPE_NOT_GRANTED' }
    : name === 'task.triage'
      ? { status: 403, code: 'DELEGATION_EXCLUDES_INTAKE' }
      : name === 'run.child_handback'
        ? { status: 401, code: 'DELEGATION_NOT_LIVE' }
        : { status: 403, code: 'DELEGATION_EXCLUDES_OPERATION' };

/** Under the pickup's credential: the reads, its lease's own commands and the correction (`PICKUP_RUN_COMMANDS`). */
const PICKUP_ADMITTED: ReadonlySet<string> = new Set([
  ...ADMITTED,
  'task.dispatch',
  'task.heartbeat',
  'task.observe',
  'task.handback',
  'run.end',
  'live_correction.request',
]);

/** Every registry command outside `admitted`, sent under `credential`, whose answer is not its refusal. */
async function outsideOf(
  w: OwnerLaunchWorld,
  credential: string,
  taskId: string,
  admitted: ReadonlySet<string>,
): Promise<readonly (readonly [string, { status: number; code: unknown }])[]> {
  const expectedRevision = await w.revisionOf(taskId);
  const answers = new Map<string, { status: number; code: unknown }>();
  for (const declaration of COMMAND_SURFACE) {
    if (admitted.has(declaration.name)) continue;
    // Sequential: one agent actor and one register.
    // eslint-disable-next-line no-await-in-loop
    const answer = await w.asAgent(
      declaration.name,
      declaration.name === 'live_correction.request'
        ? correction(taskId)
        : declaration.name === 'task.take_launch' || declaration.name === 'run.child_handback'
          ? { operationId: randomUUID(), ...OPERANDS[declaration.name] }
          : {
              operationId: randomUUID(),
              recordId: taskId,
              expectedRevision,
              ...OPERANDS[declaration.name],
            },
      credential,
    );
    answers.set(declaration.name, { status: answer.status, code: answer.body['code'] });
  }
  expect(answers.size).toBe(COMMAND_SURFACE.length - admitted.size);
  return [...answers].filter(
    ([name, answer]) =>
      answer.status !== refusalOf(name).status || answer.code !== refusalOf(name).code,
  );
}

const codeOf = (result: CommandResult): string => ('code' in result ? result.code : 'applied');

// eslint-disable-next-line max-lines-per-function -- one served API, one business and its neighbour
describe.skipIf(serverUrl === undefined)('a taken launch’s credential', () => {
  let w: OwnerLaunchWorld;

  beforeAll(async () => {
    w = await ownerLaunchWorld('taken_launch_reach');
  }, 180_000);

  afterAll(async () => {
    await w?.fixture.drop();
  });

  // One live delegation per agent and purpose: settle each case's pickup.
  afterEach(async () => {
    await w.fixture.db.admin.execute(
      `update public.delegations set settled_at = clock_timestamp()
        where business_id = $1 and purpose = $2 and settled_at is null`,
      [w.fixture.business, SYNTHETIC_STEP.kind],
    );
  });

  it('reads its own delegation, which names its task and nothing wider', async () => {
    const taskId = await w.ownersPlan(`Read its delegation ${randomUUID()}`);
    const credential = await w.takenLaunch(taskId);
    const before = await w.footprint();

    const capabilities = applied(
      await w.asAgent('session.capabilities', { operationId: randomUUID() }, credential),
    );

    expect(capabilities['purposeScope']).toStrictEqual({ kind: 'record', id: taskId });
    expect(await w.footprint()).toStrictEqual(before);
  });

  it('refuses every other operation under it, and writes nothing', async () => {
    const taskId = await w.ownersPlan(`Refuse the rest ${randomUUID()}`);
    const credential = await w.takenLaunch(taskId);
    const before = await w.footprint();

    expect(await outsideOf(w, credential, taskId, ADMITTED)).toStrictEqual([]);
    expect(await w.footprint()).toStrictEqual(before);
  });

  it('holds its pickup’s credential to the run and the correction, refusing the rest and writing nothing', async () => {
    const taskId = await w.ownersPlan(`Pickup refuses the rest ${randomUUID()}`);
    const credential = await w.takenLaunch(taskId);
    const picked = applied(
      await w.asAgent(
        'task.pickup',
        { operationId: randomUUID(), reservationId: await w.reservationOn(taskId) },
        credential,
      ),
    );
    const before = await w.footprint();

    expect(await outsideOf(w, String(picked['credential']), taskId, PICKUP_ADMITTED)).toStrictEqual(
      [],
    );
    expect(await w.footprint()).toStrictEqual(before);
  });

  it('picks up the owner’s plan on its own task alone', async () => {
    const own = await w.ownersPlan(`Its own task ${randomUUID()}`);
    const other = await w.ownersPlan(`Another task of his ${randomUUID()}`);
    const credential = await w.takenLaunch(own);
    const otherReservation = await w.reservationOn(other);
    expect(otherReservation).toBeTypeOf('string');

    const crossed = await w.asAgent(
      'task.pickup',
      { operationId: randomUUID(), reservationId: otherReservation },
      credential,
    );
    const readAcross = await w.asAgent(
      'task.read',
      { operationId: randomUUID(), recordId: other },
      credential,
    );
    expect({
      pickup: [crossed.status, crossed.body['code']],
      read: [readAcross.status, readAcross.body['code']],
      stillQueued: await w.reservationOn(other),
    }).toStrictEqual({
      pickup: [403, 'DELEGATION_OUT_OF_PURPOSE'],
      read: [403, 'DELEGATION_OUT_OF_PURPOSE'],
      stillQueued: otherReservation,
    });
  });

  it('carries the owner’s correction to a stored request under its pickup, never under the launch', async () => {
    const own = await w.ownersPlan(`Its correction ${randomUUID()}`);
    const credential = await w.takenLaunch(own);
    const picked = applied(
      await w.asAgent(
        'task.pickup',
        { operationId: randomUUID(), reservationId: await w.reservationOn(own) },
        credential,
      ),
    );
    const page = await w.ownSitePage();
    const underLaunch = await w.asAgent(
      'live_correction.request',
      correction(own, page),
      credential,
    );
    const underPickup = applied(
      await w.asAgent(
        'live_correction.request',
        correction(own, page),
        String(picked['credential']),
      ),
    );
    const stored = await w.fixture.db.admin.execute<Record<string, unknown>>(
      `select task_id::text as "taskId", party_id as "partyId" from public.live_corrections
        where business_id = $1 and id = $2`,
      [w.fixture.business, underPickup['correctionId']],
    );
    expect({
      underLaunch: underLaunch.body['code'],
      stored: JSON.parse(JSON.stringify(stored)),
    }).toStrictEqual({
      underLaunch: 'DELEGATION_EXCLUDES_OPERATION',
      stored: [{ taskId: own, partyId: null }],
    });
  });

  it('reaches nothing in another business where the same agent login is linked', async () => {
    const taskId = await w.ownersPlan(`Kept in its business ${randomUUID()}`);
    const credential = await w.takenLaunch(taskId);
    const beta = (await insertBusiness(
      w.fixture.db.app,
      `beta-${randomUUID().slice(0, 8)}`,
    )) as BusinessId;
    await installSpine(w.fixture.db.app, beta);
    const manager = await enrol(w.fixture.db.app, beta, 'manager');
    await w.fixture.db.app.withBusiness(beta, async (tx) => {
      const actorId = randomUUID();
      await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
        beta,
        actorId,
      ]);
      const loginId = await insertLogin(tx, w.fixture.agent.subject);
      await tx.query(
        `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
         values ($1, $2, $3, $4, $5)`,
        [beta, randomUUID(), loginId, actorId, manager.actorId],
      );
    });
    const inBeta = async (body: Record<string, unknown>): Promise<CommandResult> =>
      (await executeAgentCommand(
        w.fixture.db.app,
        beta,
        w.fixture.agent,
        credential,
        body as never,
      )) as CommandResult;

    const capabilities = await inBeta({
      command: 'session.capabilities',
      operationId: randomUUID(),
    });
    const read = await inBeta({
      command: 'task.read',
      operationId: randomUUID(),
      recordId: taskId,
    });

    expect({ capabilities: codeOf(capabilities), read: codeOf(read) }).toStrictEqual({
      capabilities: 'DELEGATION_NOT_LIVE',
      read: 'DELEGATION_NOT_LIVE',
    });
    expect(JSON.stringify([capabilities, read])).not.toContain(taskId);
  });
});
