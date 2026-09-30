// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-2's `state revised` (CS-16.4) as `run.revise_state`, through the real
// boundary and a fresh Postgres. The only write the agent page has: a run's
// current knowledge and unknowns, kept as versions with the actor who revised
// them. It asks `run:write` on the run's task (ORCH33); an agent reaches it
// only inside a delegation minted where its person holds `run:write`, as the
// recorded actor (ORCH34). The stored versions and audit rows, read with the
// admin role, are the oracle.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { PROPOSAL, approvedReservationId } from '../acceptance/role-case-bodies.ts';
import {
  agentPath,
  bearer,
  call,
  createWorld,
  serverUrl,
  tokenFor,
  type Answer,
  type World,
} from '../acceptance/world.ts';
import {
  asAgent,
  asPerson,
  contextOf,
  externalClient,
  signed,
  type Signed,
} from './c54-fixture.ts';

interface Run {
  readonly recordId: string;
  readonly runId: string;
}

interface Picked extends Run {
  readonly credential: string;
  readonly leaseId: string;
  readonly fence: number;
}

interface Version {
  readonly version: number;
  readonly knowledge: readonly string[];
  readonly unknowns: readonly string[];
  readonly revised_by_actor_id: string;
}

const REVISION = { knowledge: ['the brief is agreed'], unknowns: ['the launch date'] } as const;

// eslint-disable-next-line max-lines-per-function -- one world, each case on it
describe.skipIf(serverUrl === undefined)('MP-6-2 state revised on Postgres', () => {
  let world: World;
  let ada: Signed;
  let one: Run;
  let two: Run;

  /** A task ada proposed work on: the planned run the proposal made. */
  async function proposedRun(who: Signed = ada): Promise<Run> {
    const context = contextOf(world, who);
    const task = await context.freshTask('a run whose state is revised');
    const proposed = await asPerson(world, who, 'task.propose', {
      recordId: task.id,
      expectedRevision: task.revision,
      ...PROPOSAL,
    });
    if (proposed.code !== 'ok') throw new Error(`mp-6-2: propose refused ${proposed.code}`);
    const detail = proposed.body['detail'] as Record<string, unknown>;
    return { recordId: task.id, runId: String(detail['runId']) };
  }

  /** A person of `business` holding `task:<task>` and, where named, `run:write`, on the business or one task. */
  async function member(
    business: BusinessId,
    businessKey: string,
    name: string,
    grants: { readonly task: 'read' | 'write'; readonly runOn?: string | 'business' },
  ): Promise<Signed> {
    const made = await enrol(world.db.app, business, name);
    await world.db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, made, grants.task);
      if (grants.runOn === undefined) return;
      const scope =
        grants.runOn === 'business' ? undefined : { kind: 'record' as const, id: grants.runOn };
      await grantTo(tx, made, 'write', scope, false, 'run');
    });
    return { ...made, token: await tokenFor(made.presented.subject), businessKey };
  }

  /** Work ada approved, picked up by the agent, and the run it works. */
  async function pickUp(): Promise<Picked> {
    const reservationId = await approvedReservationId(contextOf(world, ada));
    const picked = await call(
      world.api,
      agentPath('alpha', '/task/pickup'),
      { operationId: randomUUID(), reservationId },
      bearer(world.agent.token),
    );
    if (picked.code !== 'ok') throw new Error(`mp-6-2: agent pickup refused ${picked.code}`);
    const detail = picked.body['detail'] as Record<string, unknown>;
    const runs = await world.db.admin.execute<{ readonly run_id: string }>(
      `select run_id from public.reservations where id = $1`,
      [reservationId],
    );
    return {
      recordId: String(detail['taskId']),
      runId: String(runs[0]?.run_id),
      credential: String(detail['credential']),
      leaseId: String(detail['leaseId']),
      fence: Number(detail['fence']),
    };
  }

  /** The agent settles the work, so its delegation for the purpose is spent. */
  async function handBack(work: Picked): Promise<void> {
    const settled = await asAgent(
      world,
      'task.handback',
      { leaseId: work.leaseId, fence: work.fence, outcome: 'completed', report: { wrote: 'done' } },
      work.credential,
    );
    if (settled.code !== 'ok') throw new Error(`mp-6-2: handback refused ${settled.code}`);
  }

  async function versionsOf(runId: string): Promise<readonly Version[]> {
    return await world.db.admin
      .execute<Version>(
        `select version, knowledge, unknowns, revised_by_actor_id
         from public.run_states where run_id = $1 order by version`,
        [runId],
      )
      .then((rows) => [...rows]);
  }

  const revise = async (
    who: Signed,
    run: Run,
    expectedVersion: number,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<Answer> =>
    await asPerson(world, who, 'run.revise_state', {
      recordId: run.recordId,
      runId: run.runId,
      expectedVersion,
      ...REVISION,
      ...extra,
    });

  const reviseAsAgent = async (work: Picked, run: Run, expectedVersion: number): Promise<Answer> =>
    await asAgent(
      world,
      'run.revise_state',
      { recordId: run.recordId, runId: run.runId, expectedVersion, ...REVISION },
      work.credential,
    );

  beforeAll(async () => {
    world = await createWorld('mp62state');
    ada = signed(world.ada);
    one = await proposedRun();
    two = await proposedRun();
  }, 180_000);

  afterAll(async () => await world?.close());

  it('MP-6-2 run:write refused: a task:read holder and a task:write holder without run:write are refused, and nothing is kept', async () => {
    // ada holds every task action and none on run, as the seeded admin does.
    const reader = await member(world.alpha, 'alpha', 'mp62-reader', { task: 'read' });
    const writer = await member(world.alpha, 'alpha', 'mp62-writer', { task: 'write' });
    for (const who of [ada, reader, writer]) {
      // eslint-disable-next-line no-await-in-loop -- one caller at a time
      const refusedAnswer = await revise(who, one, 0);
      expect(refusedAnswer.code, who.personId).toBe('SCOPE_NOT_GRANTED');
      expect(refusedAnswer.status).toBe(403);
    }
    // A delegation minted for a person without run:write reaches no run.
    const work = await pickUp();
    const agentAnswer = await reviseAsAgent(work, work, 0);
    expect(agentAnswer.code).toBe('DELEGATION_OUT_OF_PURPOSE');
    expect(JSON.stringify(agentAnswer.body)).toContain('run');
    expect(await versionsOf(one.runId)).toStrictEqual([]);
    expect(await versionsOf(work.runId)).toStrictEqual([]);
    await handBack(work);
  });

  it('MP-6-2 revisions: each revision is a version kept with its actor, a stale one is refused, and a malformed body keeps nothing', async () => {
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await grantTo(tx, ada, 'write', { kind: 'record', id: one.recordId }, false, 'run');
    });
    const first = await revise(ada, one, 0);
    expect(first.code).toBe('ok');
    expect(first.body['detail']).toStrictEqual({ runId: one.runId, version: 1 });
    const second = await revise(ada, one, 1, {
      knowledge: ['the brief is agreed', 'the copy is drafted'],
      unknowns: [],
    });
    expect((second.body['detail'] as Record<string, unknown>)['version']).toBe(2);
    // Two writers read version 1; the second to arrive is stale.
    const stale = await revise(ada, one, 1);
    expect(stale.code).toBe('VERSION_STALE');
    for (const bad of [
      { knowledge: 'not a list' },
      { unknowns: [3] },
      { knowledge: [''] },
      { knowledge: ['x'.repeat(2001)] },
      { unknowns: Array.from({ length: 51 }, (_, i) => `unknown ${i}`) },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one body at a time
      const answer = await revise(ada, one, 2, bad);
      expect(answer.code, JSON.stringify(bad).slice(0, 60)).toBe('COMMAND_BODY_INVALID');
    }
    expect(await versionsOf(one.runId)).toStrictEqual([
      { version: 1, ...REVISION, revised_by_actor_id: ada.actorId },
      {
        version: 2,
        knowledge: ['the brief is agreed', 'the copy is drafted'],
        unknowns: [],
        revised_by_actor_id: ada.actorId,
      },
    ]);
    // A run on another task answers as a run that does not exist: the grant is on `one`.
    const elsewhere = await revise(ada, { recordId: one.recordId, runId: two.runId }, 0);
    const madeUp = await revise(ada, { recordId: one.recordId, runId: randomUUID() }, 0);
    expect(elsewhere.status).toBe(404);
    expect(elsewhere.body).toStrictEqual(madeUp.body);
    expect(await versionsOf(two.runId)).toStrictEqual([]);
  });

  it('MP-6-2 revisions race: two revisions of one version at once are one applied and one VERSION_STALE', async () => {
    const race = await proposedRun();
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await grantTo(tx, ada, 'write', { kind: 'record', id: race.recordId }, false, 'run');
    });
    const answers = await Promise.all([revise(ada, race, 0), revise(ada, race, 0)]);
    expect(answers.map((answer) => answer.code).toSorted()).toStrictEqual(['VERSION_STALE', 'ok']);
    expect((await versionsOf(race.runId)).map((kept) => kept.version)).toStrictEqual([1]);
  });

  it('MP-6-2 no audit event: a revision adds only its own command event, and no other', async () => {
    const before = await world.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.audit_events where business_id = $1`,
      [world.alpha],
    );
    const answer = await revise(ada, one, 2);
    expect(answer.code).toBe('ok');
    const added = await world.db.admin.execute<{ readonly command: string }>(
      `select command from public.audit_events where business_id = $1 order by seq offset $2`,
      [world.alpha, Number(before[0]?.n)],
    );
    expect(added.map((row) => row.command)).toStrictEqual(['run.revise_state']);
  });

  it('MP-6-2 isolation: another business, another client and another person’s agent revise none of the run, and read nothing of it', async () => {
    const kept = await versionsOf(one.runId);
    const secret = kept.at(-1)?.knowledge.at(-1) ?? 'none';
    // Another business: bravo's holder of run:write on all of bravo names alpha's run.
    const bravo = await member(world.bravo, 'bravo', 'mp62-bravo', {
      task: 'write',
      runOn: 'business',
    });
    const foreign = await revise(bravo, one, 3);
    const fabricated = await revise(bravo, { recordId: randomUUID(), runId: randomUUID() }, 3);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toStrictEqual(fabricated.body);
    // Another client in the same business: shared task two, run:write on it,
    // names task one. A read share writes nothing at all (R4), so both are 403.
    const client = await externalClient(world, ada, two.recordId);
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await grantTo(tx, client, 'write', { kind: 'record', id: two.recordId }, false, 'run');
    });
    const theirs = await revise(client, one, 3);
    expect(theirs.status).toBe(403);
    const crossed = await revise(client, { recordId: two.recordId, runId: one.runId }, 3);
    expect(crossed.status).toBe(403);
    // Another person under a live delegation: an agent on ada's other work names one.
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await grantTo(tx, ada, 'write', undefined, false, 'run');
    });
    const work = await pickUp();
    const delegated = await reviseAsAgent(work, one, 3);
    expect(delegated.status).toBe(403);
    expect(delegated.code).toBe('DELEGATION_OUT_OF_PURPOSE');
    await handBack(work);
    for (const answer of [foreign, fabricated, theirs, crossed, delegated]) {
      expect(JSON.stringify(answer.body)).not.toContain(secret);
      expect(JSON.stringify(answer.body)).not.toContain(one.runId);
    }
    expect(await versionsOf(one.runId)).toStrictEqual(kept);
  });

  it('MP-6-2 state revised: the agent revises its own run inside its delegation as the recorded actor, and a sibling task’s run is outside it', async () => {
    const work = await pickUp();
    const own = await reviseAsAgent(work, work, 0);
    expect(own.code).toBe('ok');
    expect(own.body['detail']).toStrictEqual({ runId: work.runId, version: 1 });
    expect(await versionsOf(work.runId)).toStrictEqual([
      { version: 1, ...REVISION, revised_by_actor_id: world.agent.actorId },
    ]);
    const sibling = await reviseAsAgent(work, two, 0);
    expect(sibling.code).toBe('DELEGATION_OUT_OF_PURPOSE');
    expect(await versionsOf(two.runId)).toStrictEqual([]);
    await handBack(work);
  });
});
