// SPDX-License-Identifier: AGPL-3.0-only
//
// A helper's stopping step result and a grant revocation, each on its own
// server instance and connection (C41-A, SEC-P12-R5). The helper works the
// access check under a child delegation, its parent's attempt priced, failed
// and settled; a second pickup holds a reservation on the site setup, a
// ready step's task. Revoking the person's `run:write` costs both pickups, so
// the revocation locks the site setup's task, then the delegations. The
// helper's second failure withdraws every ready step's move, which locks that
// same task after the result holds its delegations. Neither side may die of a
// deadlock: the step result takes every step's task before any delegation.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authorised, ISSUER, post, tokenFor, type Answer } from '../api/fixture.ts';
import { agentPath, PROPOSAL } from '../api/controls-fixture.ts';
import { grantTo } from '../commands/fixture.ts';
import { insertLogin } from '../identity/fixture.ts';
import { seedLaunchOn } from '../runtime/launch-seed.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { testSignIn } from '../support/sign-in.ts';
import { composeApi } from '../../apps/api/server.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { useMoveWorld } from './c41-a-move-world.ts';
import { byPerson, latch, lockHold, watched, type Sent } from './c41-a-lock-hold.ts';

const serverUrl = databaseUrlFromEnvironment();

const PRICED = { item: 'synthetic_comment', quantity: 1 };

/** The answer's detail, the call having had to apply for the case to mean anything. */
function applied(answer: Answer, what: string): Record<string, unknown> {
  expect(answer.status, `${what}: ${JSON.stringify(answer.body)}`).toBe(200);
  return (answer.body['detail'] ?? {}) as Record<string, unknown>;
}

// eslint-disable-next-line max-lines-per-function -- one world, the race and the work it needs
describe.skipIf(serverUrl === undefined)('C41-A step result lock order', () => {
  const { the, onboard, done, revisionOf } = useMoveWorld('c41alockorder');
  const { stepWorld, waiters } = lockHold(the);

  // eslint-disable-next-line max-lines-per-function -- two pickups, the helper, the race
  it('C41-A races: a revocation that locks another ready step’s task, made after a helper’s stopping step result has read its delegations live, waits for that result and neither side deadlocks', async () => {
    const { controls, admin } = the;
    const { db, business, environment } = controls.fixture;
    const runGrantId = await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, admin, 'manage', { kind: 'business', id: null }, false, 'access');
      return await grantTo(tx, admin, 'write', undefined, true, 'run');
    });
    const steps = await onboard('Made-up Client Lock Order');
    for (const key of ['welcome-email', 'kickoff-call', 'access-grant']) {
      // oxlint-disable-next-line no-await-in-loop -- each opens the next
      await done(steps, key);
    }
    const check = String(steps.get('access-check'));
    const site = String(steps.get('site-setup'));
    applied(
      await controls.asPerson('onboarding.step_result', {
        recordId: check,
        outcome: 'failed',
        result: 'first attempt failed',
      }),
      'first failure',
    );

    // A pickup on the site setup, its reservation still held.
    await controls.pickup(
      await controls.approve(await controls.propose(site, await revisionOf(site), 'step_site')),
    );
    // The parent: a pickup on the access check, its attempt priced, failed and settled.
    const proposal = applied(
      await controls.asPerson('task.propose', {
        ...PROPOSAL,
        recordId: check,
        expectedRevision: await revisionOf(check),
        purpose: 'step_check',
        step: { kind: 'synthetic_comment', payload: {} },
      }),
      'task.propose',
    );
    const picked = await controls.pickup(await controls.approve(proposal));
    const parentCredential = String(picked['credential']);
    const lease = { leaseId: picked['leaseId'], fence: picked['fence'] };
    await seedLaunchOn(db.admin, business, picked['leaseId']);
    applied(await controls.asAgent('task.dispatch', lease, parentCredential), 'task.dispatch');
    applied(
      await controls.asAgent(
        'task.observe',
        { ...lease, attemptId: picked['attemptId'], usage: PRICED, outcome: 'failed' },
        parentCredential,
      ),
      'task.observe',
    );
    const held = await db.admin.execute<{ readonly task: string; readonly reservation: string }>(
      `select (case l.task_id when $1::uuid then 'check' else 'site' end) as task,
              res.state as reservation
         from public.leases l join public.reservations res on res.id = l.reservation_id
        where l.task_id = any($2::uuid[]) and l.state = 'live' order by 1`,
      [check, [check, site]],
    );
    expect(held).toEqual([
      { task: 'check', reservation: 'actual' },
      { task: 'site', reservation: 'held' },
    ]);

    // The helper: another agent of the business, handed `task:write` on the access check.
    const helperActorId = randomUUID();
    const helperSubject = `helper-${randomUUID()}`;
    await db.app.withBusiness(business, async (tx) => {
      await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
        business,
        helperActorId,
      ]);
      await tx.query(
        `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
         values ($1, $2, $3, $4, $5)`,
        [
          business,
          randomUUID(),
          await insertLogin(tx, helperSubject),
          helperActorId,
          admin.actorId,
        ],
      );
    });
    const child = applied(
      await controls.asAgent(
        'run.delegate_child',
        {
          ...lease,
          helperActorId,
          purpose: 'helper_check',
          collections: ['task'],
          actions: ['write'],
          expiresInSeconds: 600,
        },
        parentCredential,
      ),
      'run.delegate_child',
    );

    const helperCall: Sent = {
      path: agentPath('onboarding.step_result'),
      body: { operationId: randomUUID(), recordId: check, outcome: 'failed', result: 'again' },
      headers: {
        ...authorised(await tokenFor(helperSubject)),
        'x-agent-delegation': String(child['credential']),
      },
    };
    const serve = (database: Database): ReturnType<typeof composeApi>['app'] =>
      composeApi({
        keys: runtimeKeys({ ...environment }),
        database,
        admin: db.admin,
        signIn: testSignIn(ISSUER),
        executeRead,
      }).app;
    const pools = [0, 1].map(() => connect(db.appUrl, { source: 'runtime' }));
    const deadlocks: string[] = [];
    const released = latch();
    // The re-check's liveness read, its delegations held (onboarding-authority.ts).
    const helperSide = watched(pools[0] as Database, deadlocks, {
      after: "d.revocation_cause = 'authority_lost') as narrowed",
      release: released.promise,
    });
    const revokerSide = watched(pools[1] as Database, deadlocks);
    let helper: Promise<Answer> | undefined;
    let revocation: Promise<Answer> | undefined;
    let raced = '';
    try {
      helper = post(
        serve(helperSide.database),
        helperCall.path,
        helperCall.body,
        helperCall.headers,
      );
      const answered = helper.then((early) => {
        throw new Error(`the helper answered before its re-check: ${JSON.stringify(early.body)}`);
      });
      await Promise.race([helperSide.reached, answered]);
      const revoke = await byPerson(admin, 'access.revoke', { grantId: runGrantId });
      revocation = post(serve(revokerSide.database), revoke.path, revoke.body, revoke.headers);
      const sent = revocation;
      // Committed now, or waiting on a row the helper's result holds.
      raced = await Promise.race([
        sent.then(() => 'committed'),
        waiters(1).then((seen) => (seen ? 'waiting' : 'neither')),
      ]);
    } finally {
      released.resolve();
      await Promise.allSettled([helper, revocation]);
      await Promise.all(pools.map(async (pool) => await pool.close()));
    }
    const answer = await (helper as Promise<Answer>);
    const revoked = await (revocation as Promise<Answer>);
    expect(raced).toBe('waiting');
    expect(deadlocks, 'no statement of either side died of a deadlock (40P01)').toStrictEqual([]);
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(applied(answer, 'helper')).toMatchObject({ outcome: 'failed', stopped: true });
    const [rows] = await stepWorld([check, site]);
    expect(rows).toMatchObject([
      { step_key: 'access-check', state: 'stopped', failures: 2, onboarding: 'stopped' },
      { step_key: 'site-setup', state: 'ready', onboarding: 'stopped' },
    ]);
  }, 120_000);
});
