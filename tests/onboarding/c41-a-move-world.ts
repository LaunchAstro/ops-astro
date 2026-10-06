// SPDX-License-Identifier: AGPL-3.0-only
//
// The world C41-A's move cases share (c41-a-move-follows-owner and
// c41-a-step-client-lock): one business on the controls fixture, an admin who
// starts onboardings, an assignee and a self-assigner, the calls they make and
// a race of two commands held at the business's audit-chain lock.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect } from 'vitest';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { authorised, post, tokenFor, type Answer } from '../api/fixture.ts';
import { createControls, type Controls } from '../api/controls-fixture.ts';
import { ISSUER } from '../api/fixture.ts';
import { testSignIn } from '../support/sign-in.ts';
import { composeApi } from '../../apps/api/server.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';

const path = (business: string, name: string): string =>
  `/api/b/${business}/${name.replace('.', '/')}`;

export const detail = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] ?? {}) as Record<string, unknown>;

export interface RacedCommand {
  readonly name: string;
  readonly body: Readonly<Record<string, unknown>>;
}

type Call = (who: Member, name: string, body: Readonly<Record<string, unknown>>) => Promise<Answer>;

export interface MoveWorld {
  /** Filled in by beforeAll, read by the cases. */
  readonly the: {
    readonly controls: Controls;
    readonly admin: Member;
    readonly assignee: Member;
    readonly selfAssigner: Member;
  };
  readonly as: Call;
  readonly onboard: (name: string) => Promise<Map<string, string>>;
  readonly done: (steps: Map<string, string>, key: string) => Promise<void>;
  readonly revisionOf: (taskId: string) => Promise<number>;
  readonly assign: (by: Member, taskId: string, to: string | null) => Promise<Answer>;
  readonly openOn: (taskId: string) => Promise<readonly string[]>;
  readonly race: (first: RacedCommand, second: RacedCommand) => Promise<readonly [Answer, Answer]>;
}

/** The world's people and calls; registers its own beforeAll and afterAll. */
// eslint-disable-next-line max-lines-per-function -- one world, the calls that share it
export function useMoveWorld(prefix: string): MoveWorld {
  let controls: Controls;
  let admin: Member;
  let assignee: Member;
  let selfAssigner: Member;
  const the = {} as {
    controls: Controls;
    admin: Member;
    assignee: Member;
    selfAssigner: Member;
  };

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
    controls = await createControls(prefix);
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
    Object.assign(the, { controls, admin, assignee, selfAssigner });
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
    first: RacedCommand,
    second: RacedCommand,
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

  return {
    the,
    as,
    onboard,
    done,
    revisionOf,
    assign,
    openOn,
    race,
  };
}
