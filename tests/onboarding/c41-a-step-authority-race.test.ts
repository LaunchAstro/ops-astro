// SPDX-License-Identifier: AGPL-3.0-only
//
// A step result's authority is asked again once the onboarding's lock is held
// (C41-A, the checklist's "grants, delegations and expiry are checked again,
// under the lock, when the effect applies"). Each case holds the onboarding's
// row `for update` on a third connection, so the result waits there after the
// envelope's check, and the authority moves meanwhile: a committed grant
// revocation, a covering grant that lapses, a delegation that lapses. Every
// call runs on its own server instance and connection, as two requests on two
// serverless instances do.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authorised, ISSUER, post, tokenFor, type Answer } from '../api/fixture.ts';
import { agentPath } from '../api/controls-fixture.ts';
import { enrol, type Member } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { testSignIn } from '../support/sign-in.ts';
import { composeApi } from '../../apps/api/server.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { useMoveWorld } from './c41-a-move-world.ts';

const serverUrl = databaseUrlFromEnvironment();

const pause = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

interface Sent {
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;
}

const byPerson = async (
  who: Member,
  name: string,
  body: Readonly<Record<string, unknown>>,
): Promise<Sent> => ({
  path: `/api/b/alpha/${name.replace('.', '/')}`,
  body: { operationId: randomUUID(), ...body },
  headers: authorised(await tokenFor(who.presented.subject)),
});

// eslint-disable-next-line max-lines-per-function -- one world, the races that share it
describe.skipIf(serverUrl === undefined)('C41-A step result authority after the lock', () => {
  const { the, onboard, revisionOf } = useMoveWorld('c41aauth');

  /** The step's onboarding and the client it is for. */
  const onboardingOf = async (
    taskId: string,
  ): Promise<{ readonly onboardingId: string; readonly clientId: string }> => {
    const [row] = await the.controls.fixture.db.admin.execute<{
      readonly onboarding_id: string;
      readonly client_id: string;
    }>(
      `select o.id::text as onboarding_id, o.client_id::text as client_id
         from public.onboarding_steps s join public.onboardings o on o.id = s.onboarding_id
        where s.task_id = $1`,
      [taskId],
    );
    if (row === undefined) throw new Error('no onboarding holds that step');
    return { onboardingId: row.onboarding_id, clientId: row.client_id };
  };

  /** A member whose one task:write grant covers the client, lapsing at `ends` when given. */
  const writerOn = async (
    clientId: string,
    ends: Date | null = null,
  ): Promise<{ readonly member: Member; readonly grantId: string }> => {
    const { db, business } = the.controls.fixture;
    const member = await enrol(db.app, business, 'step-writer');
    const grantId = await db.app.withBusiness(business, async (tx) => {
      const issued = await issueGrant(tx, [], {
        subject: { kind: 'person', id: member.personId },
        scope: { kind: 'party', id: clientId },
        collection: 'task',
        action: 'write',
        parentGrantId: null,
        grantedByActorId: the.admin.actorId,
        expiresAt: ends,
      });
      if (!issued.ok) throw new Error(issued.refusal.code);
      return issued.value;
    });
    return { member, grantId };
  };

  /** Every step, its onboarding and comments, and the inbox items on them, read past row security. */
  const stepWorld = async (tasks: readonly string[]): Promise<readonly unknown[]> => {
    const { admin } = the.controls.fixture.db;
    return [
      await admin.execute(
        `select s.step_key, s.state, s.failures, o.state as onboarding, o.revision::text,
                (select count(*) from public.records c where c.data ->> 'task' = s.task_id::text)::text as comments
           from public.onboarding_steps s join public.onboardings o on o.id = s.onboarding_id
          where s.task_id = any($1::uuid[]) order by s.position`,
        [tasks],
      ),
      await admin.execute(
        `select id, recipient_person_id, work_state, closed_at
           from public.inbox_items where subject_record_id = any($1::uuid[]) order by id`,
        [tasks],
      ),
    ];
  };

  /** How many sessions of this database wait on a lock, polled up to `n` or about 10 s. */
  const waiters = async (n: number): Promise<boolean> => {
    for (let tries = 0; tries < 200; tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- polling
      const [row] = await the.controls.fixture.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
      );
      if (Number(row?.n) >= n) return true;
      // oxlint-disable-next-line no-await-in-loop -- polling
      await pause(50);
    }
    return false;
  };

  /**
   * The onboarding's row held `for update` on one connection while `first`
   * runs on another and waits on it; `meanwhile` runs with it waiting. The
   * hold ends when `meanwhile` returns; every call is then answered.
   */
  const whileHeld = async (
    onboardingId: string,
    first: Sent,
    meanwhile: (send: (sent: Sent) => Promise<Answer>) => Promise<void>,
  ): Promise<Answer> => {
    const { db, business, environment } = the.controls.fixture;
    const pools: Database[] = [];
    const send = async (sent: Sent): Promise<Answer> => {
      const database = connect(db.appUrl, { source: 'runtime' });
      pools.push(database);
      const { app } = composeApi({
        keys: runtimeKeys({ ...environment }),
        database,
        admin: db.admin,
        signIn: testSignIn(ISSUER),
        executeRead,
      });
      return await post(app, sent.path, sent.body, sent.headers);
    };
    const holder = connect(db.appUrl, { source: 'runtime' });
    pools.push(holder);
    let answer: Promise<Answer> | undefined;
    try {
      await holder.withBusiness(business, async (tx) => {
        await tx.query('select id from public.onboardings where id = $1 for update', [
          onboardingId,
        ]);
        answer = send(first);
        expect(await waiters(1)).toBe(true);
        await meanwhile(send);
      });
      return await (answer as Promise<Answer>);
    } finally {
      await answer?.catch(() => null);
      await Promise.all(pools.map(async (pool) => await pool.close()));
    }
  };

  it('C41-A races: a revocation of the writer’s one covering grant, made while the step result waits on the onboarding lock, waits for that result', async () => {
    const steps = await onboard('Made-up Client Revoke Race');
    const welcome = String(steps.get('welcome-email'));
    const { onboardingId, clientId } = await onboardingOf(welcome);
    const { member, grantId } = await writerOn(clientId);
    const first = await byPerson(member, 'onboarding.step_result', {
      recordId: welcome,
      outcome: 'done',
      result: 'revoked writer result',
    });
    let revoked: Promise<Answer> | undefined;
    let raced = '';
    const answer = await whileHeld(onboardingId, first, async (send) => {
      const revocation = send(await byPerson(the.admin, 'grant.revoke', { grantId }));
      revoked = revocation;
      // Committed now, or waiting on the grant row the result holds.
      raced = await Promise.race([
        revocation.then(() => 'committed'),
        waiters(2).then((seen) => (seen ? 'waiting' : 'neither')),
      ]);
    });
    const revocation = await (revoked as Promise<Answer>);
    expect(raced).toBe('waiting');
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(revocation.status, JSON.stringify(revocation.body)).toBe(200);
    const [rows] = await stepWorld([welcome, String(steps.get('kickoff-call'))]);
    expect(rows).toMatchObject([
      { step_key: 'welcome-email', state: 'done', comments: '1' },
      { step_key: 'kickoff-call', state: 'ready' },
    ]);
  }, 60_000);

  it('C41-A races: a writer whose one covering grant lapses while the step result waits on the onboarding lock is refused, writing nothing', async () => {
    const steps = await onboard('Made-up Client Lapse Race');
    const welcome = String(steps.get('welcome-email'));
    const tasks = [...steps.values()];
    const { onboardingId, clientId } = await onboardingOf(welcome);
    const { member } = await writerOn(clientId, new Date(Date.now() + 3000));
    const before = await stepWorld(tasks);
    const first = await byPerson(member, 'onboarding.step_result', {
      recordId: welcome,
      outcome: 'done',
      result: 'lapsed writer result',
    });
    const answer = await whileHeld(onboardingId, first, async () => {
      await pause(3500);
    });
    expect([answer.status, answer.body['code']]).toStrictEqual([403, 'SCOPE_NOT_GRANTED']);
    expect(await stepWorld(tasks)).toStrictEqual(before);
  }, 60_000);

  it('C41-A races: a delegation that lapses while its agent’s step result waits on the onboarding lock is refused, writing nothing', async () => {
    const steps = await onboard('Made-up Client Delegation Lapse');
    const welcome = String(steps.get('welcome-email'));
    const tasks = [...steps.values()];
    const { onboardingId } = await onboardingOf(welcome);
    const { controls } = the;
    const proposal = await controls.propose(welcome, await revisionOf(welcome), 'step_welcome');
    const credential = String(
      (await controls.pickup(await controls.approve(proposal)))['credential'],
    );
    await controls.fixture.db.admin.execute(
      `update public.delegations set expires_at = clock_timestamp() + interval '3 seconds'
        where purpose_scope_id = $1 and revoked_at is null`,
      [welcome],
    );
    const before = await stepWorld(tasks);
    const first: Sent = {
      path: agentPath('onboarding.step_result'),
      body: { operationId: randomUUID(), recordId: welcome, outcome: 'done', result: 'lapsed' },
      headers: {
        ...authorised(await tokenFor(controls.fixture.agent.subject)),
        'x-agent-delegation': credential,
      },
    };
    const answer = await whileHeld(onboardingId, first, async () => {
      await pause(3500);
    });
    expect([answer.status, answer.body['code']]).toStrictEqual([403, 'DELEGATION_NOT_LIVE']);
    expect(await stepWorld(tasks)).toStrictEqual(before);
  }, 60_000);
});
