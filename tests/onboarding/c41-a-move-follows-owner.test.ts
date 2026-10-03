// SPDX-License-Identifier: AGPL-3.0-only
//
// C41-A's inbox raise follows the owner rule (U38, CS-15.4): the reviewers'
// proofs on the draft and the follow-up cases, each red with its fix undone.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { authorised, post, tokenFor, type Answer } from '../api/fixture.ts';
import { createControls, type Controls } from '../api/controls-fixture.ts';
import { ISSUER } from '../api/fixture.ts';
import { testSignIn } from '../support/sign-in.ts';
import { composeApi } from '../../apps/api/server.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';

const serverUrl = databaseUrlFromEnvironment();

const path = (business: string, name: string): string =>
  `/api/b/${business}/${name.replace('.', '/')}`;

const detail = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] ?? {}) as Record<string, unknown>;

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C41-A inbox raise: the move follows its owner', () => {
  let controls: Controls;
  let admin: Member;
  let assignee: Member;
  let selfAssigner: Member;

  const as = async (
    who: Member,
    name: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Answer> =>
    await post(
      controls.api,
      path('alpha', name),
      { operationId: randomUUID(), ...body },
      authorised(await tokenFor(who.presented.subject)),
    );

  const onboard = async (name: string): Promise<Map<string, string>> => {
    const created = await as(admin, 'record.create', { type: 'client', fields: { name } });
    expect(created.status).toBe(200);
    const started = await as(admin, 'onboarding.start', {
      clientId: String(detail(created)['recordId']),
      templateKey: 'standard',
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const steps = detail(started)['steps'] as readonly { key: string; taskId: string }[];
    return new Map(steps.map((one) => [one.key, one.taskId]));
  };

  const done = async (steps: Map<string, string>, key: string): Promise<void> => {
    const answer = await as(admin, 'onboarding.step_result', {
      recordId: steps.get(key),
      outcome: 'done',
      result: `${key} done`,
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  };

  const revisionOf = async (taskId: string): Promise<number> => {
    const [row] = await controls.fixture.db.admin.execute<{ readonly revision: string }>(
      'select revision::text as revision from public.records where id = $1',
      [taskId],
    );
    return Number(row?.revision);
  };

  const assign = async (by: Member, taskId: string, to: string | null): Promise<Answer> =>
    await as(by, 'task.assign', {
      recordId: taskId,
      expectedRevision: await revisionOf(taskId),
      fields: { assignee: to },
    });

  const openOn = async (taskId: string): Promise<readonly string[]> =>
    (
      await controls.fixture.db.admin.execute<{ readonly recipient: string }>(
        `select recipient_person_id::text as recipient from public.inbox_items
          where subject_record_id = $1 and work_state = 'open' order by recipient_person_id`,
        [taskId],
      )
    ).map((row) => row.recipient);

  beforeAll(async () => {
    controls = await createControls('c41asol');
    const { db, business } = controls.fixture;
    admin = controls.manager;
    assignee = await enrol(db.app, business, 'assignee');
    selfAssigner = await enrol(db.app, business, 'selfassigner');
    const whole = { kind: 'business', id: null } as const;
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, admin, 'write', whole, false, 'record');
      await grantTo(tx, assignee, 'write', whole, false, 'task');
      await grantTo(tx, selfAssigner, 'assign', whole, false, 'task');
      await grantTo(tx, admin, 'share', whole, false, 'task');
    });
  });

  afterAll(async () => {
    await controls.drop();
  });

  /**
   * Two commands raced on two server instances, each on its own connection, as
   * two requests on two serverless instances are. A third connection holds the
   * business's audit-chain lock, so each command stops at its audit write, its
   * other writes made, uncommitted: `first` runs, then `second` while `first`
   * waits; both are answered once the lock goes.
   */
  const race = async (
    first: { readonly name: string; readonly body: Readonly<Record<string, unknown>> },
    second: { readonly name: string; readonly body: Readonly<Record<string, unknown>> },
  ): Promise<readonly [Answer, Answer]> => {
    const { db, business, environment } = controls.fixture;
    const pools = [0, 1, 2].map(() => connect(db.appUrl, { source: 'runtime' }));
    const [one, two, holder] = pools as [Database, Database, Database];
    const on = async (database: Database, command: typeof first): Promise<Answer> =>
      await post(
        composeApi({
          keys: runtimeKeys({ ...environment }),
          database,
          admin: db.admin,
          signIn: testSignIn(ISSUER),
          executeRead,
        }).app,
        path('alpha', command.name),
        { operationId: randomUUID(), ...command.body },
        authorised(await tokenFor(admin.presented.subject)),
      );
    const until = async (n: number): Promise<void> => {
      for (let tries = 0; tries < 200; tries += 1) {
        // oxlint-disable-next-line no-await-in-loop -- polling
        const [row] = await db.admin.execute<{ readonly n: string }>(
          `select count(*)::text as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
        );
        if (Number(row?.n) >= n) return;
        // oxlint-disable-next-line no-await-in-loop -- polling
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
      }
      throw new Error(`never saw ${n} waiters`);
    };
    const answers: Promise<Answer>[] = [];
    try {
      await holder.withBusiness(business, async (tx) => {
        await tx.query('select pg_advisory_xact_lock(hashtextextended($1::text, 0))', [business]);
        answers.push(on(one, first));
        await until(1);
        answers.push(on(two, second));
        await until(2);
      });
      const [a, b] = await Promise.all(answers);
      return [a as Answer, b as Answer];
    } finally {
      await Promise.all(pools.map(async (pool) => await pool.close()));
    }
  };

  it('a step opening while its task is being assigned leaves the move with the assignee alone, not a stale item to the starter too', async () => {
    const steps = await onboard('Made-up Client Race');
    const kickoff = String(steps.get('kickoff-call'));
    // The result that opens the kickoff step comes while its assignment is uncommitted.
    const answers = await race(
      {
        name: 'task.assign',
        body: {
          recordId: kickoff,
          expectedRevision: await revisionOf(kickoff),
          fields: { assignee: assignee.personId },
        },
      },
      {
        name: 'onboarding.step_result',
        body: { recordId: steps.get('welcome-email'), outcome: 'done', result: 'sent' },
      },
    );
    for (const answer of answers) expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    // Both committed and the kickoff task is assigned: its move is the assignee's alone.
    expect(await openOn(kickoff)).toStrictEqual([assignee.personId]);
  });

  it('C41-A races: a step result racing the unassignment of its task leaves no item open on the closed step', async () => {
    const steps = await onboard('Made-up Client Closing Race');
    const kickoff = String(steps.get('kickoff-call'));
    await done(steps, 'welcome-email');
    const to = await assign(admin, kickoff, assignee.personId);
    expect(to.status, JSON.stringify(to.body)).toBe(200);
    // The unassignment parks the ready step on the starter; the result closes it meanwhile.
    const answers = await race(
      {
        name: 'task.assign',
        body: {
          recordId: kickoff,
          expectedRevision: await revisionOf(kickoff),
          fields: { assignee: null },
        },
      },
      {
        name: 'onboarding.step_result',
        body: { recordId: kickoff, outcome: 'done', result: 'held' },
      },
    );
    for (const answer of answers) expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    // The step is closed: nobody owes it a move.
    expect(await openOn(kickoff)).toStrictEqual([]);
  });

  it('unassigning a ready person step leaves it parked with an item to the starter', async () => {
    const steps = await onboard('Made-up Client Unassign');
    const kickoff = String(steps.get('kickoff-call'));
    await done(steps, 'welcome-email');
    expect(await openOn(kickoff)).toStrictEqual([admin.personId]);
    const to = await assign(admin, kickoff, assignee.personId);
    expect(to.status, JSON.stringify(to.body)).toBe(200);
    expect(await openOn(kickoff)).toStrictEqual([assignee.personId]);
    const back = await assign(admin, kickoff, null);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    // No assignee: the move falls back to the person who started the onboarding.
    expect(await openOn(kickoff)).toStrictEqual([admin.personId]);
  });

  it('C41-A CS-15.4: unassigning a ready step of a stopped onboarding parks it on nobody', async () => {
    const steps = await onboard('Made-up Client Stopped');
    await done(steps, 'welcome-email');
    await done(steps, 'kickoff-call');
    for (const attempt of ['first', 'second']) {
      // oxlint-disable-next-line no-await-in-loop -- the second failure stops it
      const failed = await as(admin, 'onboarding.step_result', {
        recordId: steps.get('site-setup'),
        outcome: 'failed',
        result: `${attempt} try failed`,
      });
      expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    }
    const grant = String(steps.get('access-grant'));
    const to = await assign(admin, grant, assignee.personId);
    expect(to.status, JSON.stringify(to.body)).toBe(200);
    const back = await assign(admin, grant, null);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    // A person restarts a stopped onboarding; until then no step is anyone's move.
    expect(await openOn(grant)).toStrictEqual([]);
  });

  it('a person who takes a ready person step themselves holds its item', async () => {
    const steps = await onboard('Made-up Client Self');
    const kickoff = String(steps.get('kickoff-call'));
    await done(steps, 'welcome-email');
    expect(await openOn(kickoff)).toStrictEqual([admin.personId]);
    const took = await assign(selfAssigner, kickoff, selfAssigner.personId);
    expect(took.status, JSON.stringify(took.body)).toBe(200);
    // The move is now the assignee's: the starter's item went, and one is theirs.
    expect(await openOn(kickoff)).toStrictEqual([selfAssigner.personId]);
  });
  it('a step whose task moved to another client before it opens raises nothing for this onboarding', async () => {
    const steps = await onboard('Made-up Client Moved');
    const other = await as(admin, 'record.create', {
      type: 'client',
      fields: { name: 'Made-up Client Elsewhere' },
    });
    expect(other.status).toBe(200);
    const kickoff = String(steps.get('kickoff-call'));
    const moved = await as(admin, 'task.set_party', {
      recordId: kickoff,
      expectedRevision: await revisionOf(kickoff),
      fields: { client: String(detail(other)['recordId']) },
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    await done(steps, 'welcome-email');
    // The task is another client's now: this onboarding no longer closes it
    // (step_result answers 404), so it parks nobody on it either.
    const closing = await as(admin, 'onboarding.step_result', {
      recordId: kickoff,
      outcome: 'done',
      result: 'held',
    });
    expect(closing.status).toBe(404);
    expect(await openOn(kickoff)).toStrictEqual([]);
  });

  it('a step its assignee took before it opened raises its item to that assignee when it opens', async () => {
    // Red with the assignee leg of `raiseStepMoves` removed,
    // which every case in c41-a-inbox-raise.test.ts survives (check script).
    const steps = await onboard('Made-up Client Took');
    const kickoff = String(steps.get('kickoff-call'));
    const took = await assign(selfAssigner, kickoff, selfAssigner.personId);
    expect(took.status, JSON.stringify(took.body)).toBe(200);
    expect(await openOn(kickoff)).toStrictEqual([]);
    await done(steps, 'welcome-email');
    expect(await openOn(kickoff)).toStrictEqual([selfAssigner.personId]);
  });
});
