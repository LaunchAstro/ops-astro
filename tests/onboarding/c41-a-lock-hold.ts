// SPDX-License-Identifier: AGPL-3.0-only
//
// The hold C41-A's authority races share: an onboarding's row held `for
// update` on its own connection while a step result waits on it, each call on
// its own server instance and connection, and the reads the cases compare.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { authorised, ISSUER, post, tokenFor, type Answer } from '../api/fixture.ts';
import { enrol, type Member } from '../commands/fixture.ts';
import { testSignIn } from '../support/sign-in.ts';
import { composeApi } from '../../apps/api/server.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import type { MoveWorld } from './c41-a-move-world.ts';

export const pause = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

export interface Sent {
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;
}

export const byPerson = async (
  who: Member,
  name: string,
  body: Readonly<Record<string, unknown>>,
): Promise<Sent> => ({
  path: `/api/b/alpha/${name.replace('.', '/')}`,
  body: { operationId: randomUUID(), ...body },
  headers: authorised(await tokenFor(who.presented.subject)),
});

export interface LockHold {
  readonly onboardingOf: (
    taskId: string,
  ) => Promise<{ readonly onboardingId: string; readonly clientId: string }>;
  readonly writerOn: (
    clientId: string,
    ends?: Date | null,
  ) => Promise<{ readonly member: Member; readonly grantId: string }>;
  readonly stepWorld: (tasks: readonly string[]) => Promise<readonly unknown[]>;
  readonly waiters: (n: number) => Promise<boolean>;
  readonly whileHeld: (
    onboardingId: string,
    first: Sent,
    meanwhile: (send: (sent: Sent) => Promise<Answer>) => Promise<void>,
  ) => Promise<Answer>;
}

/** The world's hold and reads, over the world `the` fills in. */
// eslint-disable-next-line max-lines-per-function -- one hold, the reads its cases share
export function lockHold(the: MoveWorld['the']): LockHold {
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

  return { onboardingOf, writerOn, stepWorld, waiters, whileHeld };
}
