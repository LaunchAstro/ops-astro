// SPDX-License-Identifier: AGPL-3.0-only
//
// A helper's step result under a child delegation, and its parent revoked
// between the result's liveness read and its write (C41-A, "grants,
// delegations and expiry are checked again, under the lock, when the effect
// applies"). The parent's attempt is priced, failed and settled, so its
// reservation is actual and the revocation holds nothing the result holds
// on its account; and no task names the parent as its agent. The helper's
// call runs on its own server instance and connection, with a test-only
// barrier after the real liveness read; the revocation runs on another.

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
import { byPerson, lockHold, type Sent } from './c41-a-lock-hold.ts';

const serverUrl = databaseUrlFromEnvironment();

const PRICED = { item: 'synthetic_comment', quantity: 1 };

/** The answer's detail, the call having had to apply for the case to mean anything. */
function applied(answer: Answer, what: string): Record<string, unknown> {
  expect(answer.status, `${what}: ${JSON.stringify(answer.body)}`).toBe(200);
  return (answer.body['detail'] ?? {}) as Record<string, unknown>;
}

/** A promise and the call that resolves it, for holding one side of a schedule. */
function latch(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  const box: { resolve?: () => void } = {};
  const promise = new Promise<void>((resolve) => {
    box.resolve = resolve;
  });
  return { promise, resolve: () => box.resolve?.() };
}

/**
 * `database`, its transactions stopping once the statement `after` names has
 * answered: `reached` resolves then, and the transaction goes on, still
 * open, when `release` does.
 */
function barred(
  database: Database,
  after: string,
  release: Promise<void>,
): { readonly database: Database; readonly reached: Promise<void> } {
  const reached = latch();
  const wrapped: Database = {
    log: database.log,
    close: async () => {
      await database.close();
    },
    withBusiness: async (business, run) =>
      await database.withBusiness(business, async (tx) => {
        const query: typeof tx.query = async <Row>(
          text: string,
          parameters?: readonly unknown[],
        ): Promise<readonly Row[]> => {
          const rows = await tx.query<Row>(text, parameters);
          if (text.includes(after)) {
            reached.resolve();
            await release;
          }
          return rows;
        };
        return await run(
          new Proxy(tx, {
            get: (target, key) => {
              if (key === 'query') return query;
              const value: unknown = Reflect.get(target, key);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }),
        );
      }),
  };
  return { database: wrapped, reached: reached.promise };
}

// eslint-disable-next-line max-lines-per-function -- one world, the race and the parent work it needs
describe.skipIf(serverUrl === undefined)('C41-A step result under a child delegation', () => {
  const { the, onboard, revisionOf } = useMoveWorld('c41achild');
  const { stepWorld, waiters } = lockHold(the);

  // eslint-disable-next-line max-lines-per-function -- the parent's priced attempt, the helper, the race
  it('C41-A races: a revocation of the helper’s parent delegation, made after the helper’s step result has read its delegation live, waits for that result', async () => {
    const { controls, admin } = the;
    const { db, business, environment } = controls.fixture;
    const steps = await onboard('Made-up Client Parent Revoke');
    const welcome = String(steps.get('welcome-email'));
    const tasks = [...steps.values()];

    // The parent: a pickup that reaches `task` and `run`, its attempt priced,
    // failed and settled, so its reservation is actual and its lease and
    // delegation stay live.
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, admin, 'write', undefined, true, 'run');
    });
    const proposal = applied(
      await controls.asPerson('task.propose', {
        ...PROPOSAL,
        recordId: welcome,
        expectedRevision: await revisionOf(welcome),
        purpose: 'step_welcome',
        // A step whose effect replays, so the attempt can be dispatched.
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
    const [parent] = await db.admin.execute<{
      readonly delegation_id: string;
      readonly reservation: string;
      readonly lease: string;
      readonly agent_tasks: string;
    }>(
      `select l.delegation_id::text, res.state as reservation, l.state as lease,
              (select count(*) from public.records r
                where r.data ->> 'agent' = l.delegation_id::text)::text as agent_tasks
         from public.leases l
         join public.attempts att on att.lease_id = l.id
         join public.reservations res on res.id = att.reservation_id
        where l.id = $1`,
      [picked['leaseId']],
    );
    expect(parent).toMatchObject({ reservation: 'actual', lease: 'live', agent_tasks: '0' });

    // The helper: another agent of the business, handed `task:write` on the
    // welcome step's task by the parent.
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
          purpose: 'helper_welcome',
          collections: ['task'],
          actions: ['write'],
          expiresInSeconds: 600,
        },
        parentCredential,
      ),
      'run.delegate_child',
    );

    const before = await stepWorld(tasks);
    const helperCall: Sent = {
      path: agentPath('onboarding.step_result'),
      body: {
        operationId: randomUUID(),
        recordId: welcome,
        outcome: 'done',
        result: 'helper result',
      },
      headers: {
        ...authorised(await tokenFor(helperSubject)),
        'x-agent-delegation': String(child['credential']),
      },
    };

    const pools: Database[] = [];
    const serve = (database: Database): ReturnType<typeof composeApi>['app'] =>
      composeApi({
        keys: runtimeKeys({ ...environment }),
        database,
        admin: db.admin,
        signIn: testSignIn(ISSUER),
        executeRead,
      }).app;
    const released = latch();
    const helperDb = connect(db.appUrl, { source: 'runtime' });
    const revokerDb = connect(db.appUrl, { source: 'runtime' });
    pools.push(helperDb, revokerDb);
    // The re-check's liveness read under the onboarding's lock, by its own
    // words (onboarding-authority.ts); the envelope's `resolveDelegation`
    // also names `narrowed`, unqualified, before that lock.
    const barrier = barred(
      helperDb,
      "d.revocation_cause = 'authority_lost') as narrowed",
      released.promise,
    );
    let helper: Promise<Answer> | undefined;
    let revocation: Promise<Answer> | undefined;
    let raced = '';
    try {
      helper = post(serve(barrier.database), helperCall.path, helperCall.body, helperCall.headers);
      const answered = helper.then((early) => {
        throw new Error(`the helper answered before its re-check: ${JSON.stringify(early.body)}`);
      });
      await Promise.race([barrier.reached, answered]);
      const revoke = await byPerson(admin, 'delegation.revoke', {
        delegationId: parent?.delegation_id,
      });
      revocation = post(serve(revokerDb), revoke.path, revoke.body, revoke.headers);
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
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    if (answer.status === 200) {
      const [rows] = await stepWorld([welcome, String(steps.get('kickoff-call'))]);
      expect(rows).toMatchObject([
        { step_key: 'welcome-email', state: 'done', comments: '1' },
        { step_key: 'kickoff-call', state: 'ready' },
      ]);
    } else {
      expect(await stepWorld(tasks)).toStrictEqual(before);
    }
  }, 90_000);
});
