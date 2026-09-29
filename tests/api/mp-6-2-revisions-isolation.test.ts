// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-2, `state revised`'s authority and isolation, through the real
// boundary and a fresh Postgres.
//
// `run.revise_state` is `run:write` (ORCH25-SL12B-RUN): it answers to the
// exact pair the delegation carries and to the delegating person's live
// grant, both read again under the lease lock, and a person working their own
// lease answers to their own `run:write`. The crossings: another business (A's
// agent and credential at Bravo's address); another client in the same
// business (A's credential against client two's lease); and another person's
// work under a live delegation (B's agent against A's lease and A's task).
// Each checks the status, that nothing was written, and that no body carries
// the canary in every line of A's knowledge, refusals included.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import { authorised, post, tokenFor, type Answer } from './fixture.ts';
import { detailOf } from './controls-fixture.ts';
import { pickedUpOn } from './mp-6-1-checks-fixture.ts';
import {
  REVISIONS,
  knowledge,
  revisionsWorld,
  type RevisionsWorld,
} from './mp-6-2-revisions-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const noop = (): void => undefined;

/** Waits until a backend of this database is queued on a row lock. */
async function aBackendWaits(owner: postgres.Sql): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    const [row] = await owner<{ n: string }[]>`
      select count(*)::text as n from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock'`;
    if (Number(row?.n) >= 1) return;
    // eslint-disable-next-line no-await-in-loop
    await sleep(25);
  }
  throw new Error('no backend ever waited on the lease lock');
}

// eslint-disable-next-line max-lines-per-function -- one world of two businesses, every refusal and crossing on it
describe.skipIf(serverUrl === undefined)('MP-6-2 state revised, authority', () => {
  let w: RevisionsWorld;

  beforeAll(async () => {
    w = await revisionsWorld('mp_6_2_revisions_isolation');
  }, 180_000);

  let owner: postgres.Sql | undefined;

  afterAll(async () => {
    await owner?.end();
    await w?.c.drop();
  });

  const restoreRunWrite = async (): Promise<void> => {
    await w.c.fixture.db.app.withBusiness(w.c.fixture.business, async (tx) => {
      await grantTo(tx, w.c.manager, 'write', undefined, false, 'run');
    });
  };

  const carriesNothingOfA = (answer: Answer): void => {
    const text = JSON.stringify(answer.body);
    for (const each of [w.canary, w.workA.taskId, w.workA.leaseId]) {
      expect(text).not.toContain(each);
    }
  };

  // eslint-disable-next-line max-lines-per-function -- the named test's three callers
  describe('MP-6-2 run:write refused', () => {
    it('an agent whose delegation does not carry run:write is refused and writes nothing', async () => {
      const answer = await w.asAgentB('run.revise_state', {
        leaseId: w.leaseB,
        fence: w.fenceB,
        ...knowledge('b'),
      });
      expect(answer.status).toBe(403);
      expect(answer.body['code']).toBe('DELEGATION_OUT_OF_PURPOSE');
      expect(await w.c.count(REVISIONS, [w.taskB])).toBe(0);
    });

    it('a person holding no run:write is refused on their own lease and writes nothing', async () => {
      const task = await w.c.createTask('the writer’s own work');
      const proposal = await w.c.propose(task.id, task.revision, 'writer_works_it');
      const reservationId = await w.c.approve(proposal);
      const picked = await w.c.asPerson(
        'task.pickup',
        { reservationId, leaseSeconds: 600 },
        w.writer,
      );
      expect(picked.status, JSON.stringify(picked.body)).toBe(200);
      const answer = await w.c.asPerson(
        'run.revise_state',
        {
          leaseId: detailOf(picked)['leaseId'],
          fence: detailOf(picked)['fence'],
          ...knowledge('writer'),
        },
        w.writer,
      );
      expect(answer.status).toBe(403);
      expect(answer.body['code']).toBe('SCOPE_NOT_GRANTED');
      expect(await w.c.count(REVISIONS, [task.id])).toBe(0);
    });

    it('the delegating person losing run:write narrows the next revision, which writes nothing', async () => {
      const work = await pickedUpOn(w.c, 'revise_after_run_write_lost');
      const { business } = w.c.fixture;
      await w.c.fixture.db.admin.execute(
        `update public.grants set revoked_at = now()
          where business_id = $1 and collection = 'run' and revoked_at is null`,
        [business],
      );
      try {
        const answer = await w.revise(work, knowledge('narrowed'));
        expect(answer.status).toBe(403);
        expect(answer.body['code']).toBe('DELEGATION_NARROWED');
        expect(await w.c.count(REVISIONS, [work.taskId])).toBe(0);
      } finally {
        await restoreRunWrite();
      }
    });

    it('run:write revoked while the revision waits on the lease lock writes nothing', async () => {
      const work = await pickedUpOn(w.c, 'revise_while_revoked');
      const url = new URL(serverUrl as string);
      url.pathname = `/${w.c.fixture.db.name}`;
      owner ??= postgres(url.toString(), { max: 2, onnotice: noop });
      const held = owner;
      let release: () => void = noop;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = held.begin(async (sql) => {
        await sql`select 1 from public.leases where id = ${work.leaseId} for update`;
        await released;
      });
      try {
        // The call-time check passes; the revision then queues on the lease.
        const revising = w.revise(work, knowledge('raced'));
        await aBackendWaits(held);
        await held`update public.grants set revoked_at = now()
                    where business_id = ${w.c.fixture.business}
                      and collection = 'run' and revoked_at is null`;
        release();
        await blocker;
        const answer = await revising;
        expect(answer.status, JSON.stringify(answer.body)).toBe(403);
        expect(answer.body['code']).toBe('DELEGATION_NARROWED');
        expect(await w.c.count(REVISIONS, [work.taskId])).toBe(0);
      } finally {
        release();
        await blocker.catch(noop);
        await restoreRunWrite();
      }
    }, 60_000);
  });

  // eslint-disable-next-line max-lines-per-function -- three crossings and a reader
  describe('MP-6-2 isolation: revisions', () => {
    it('another business: A’s agent and credential at Bravo’s address revise nothing', async () => {
      const answer = await post(
        w.c.api,
        '/api/a/b/bravo/run/revise_state',
        {
          operationId: randomUUID(),
          leaseId: w.workA.leaseId,
          fence: w.workA.fence,
          ...knowledge('x'),
        },
        {
          ...authorised(await tokenFor(w.c.fixture.agent.subject)),
          'x-agent-delegation': w.workA.credential,
        },
      );
      expect(answer.status).toBe(401);
      carriesNothingOfA(answer);
      expect(await w.c.count(REVISIONS, [w.workA.taskId])).toBe(1);
    });

    it('another client in the same business: A’s credential revises nothing of client two', async () => {
      const answer = await w.revise(
        { ...w.workA, leaseId: w.leaseB, fence: w.fenceB },
        knowledge('x'),
      );
      expect(answer.status).toBe(403);
      expect(answer.body['code']).toBe('DELEGATION_OUT_OF_PURPOSE');
      expect(JSON.stringify(answer.body)).not.toContain(w.taskB);
      expect(await w.c.count(REVISIONS, [w.taskB])).toBe(0);
    });

    it('another person’s work under a live delegation: B’s agent neither revises nor reads A’s', async () => {
      const answer = await w.asAgentB('run.revise_state', {
        leaseId: w.workA.leaseId,
        fence: w.workA.fence,
        ...knowledge('x'),
      });
      expect(answer.status).toBe(403);
      carriesNothingOfA(answer);
      const read = await w.asAgentB('task.read', { recordId: w.workA.taskId });
      expect(read.status).toBe(403);
      carriesNothingOfA(read);
      expect(await w.c.count(REVISIONS, [w.workA.taskId])).toBe(1);
    });

    it('a reader of client two’s task sees none of A’s knowledge', async () => {
      const read = await w.c.asPerson('task.read', { recordId: w.taskB });
      expect(read.status).toBe(200);
      expect(JSON.stringify(read.body)).not.toContain(w.canary);
    });
  });
});
