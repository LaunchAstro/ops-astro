// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-1, the run's checks, through the real boundary and a fresh Postgres.
//
// `task.check` is how a run records a check it performed (CS-16.3). It is a
// system write: the caller is the holder of the run's live lease, and the row
// names that holder as the agent that performed it and the version the lease
// works. With no live lease there is nothing to write under, so it is refused
// and nothing is written (TR-S-R4-9).
//
// The run controls' authority is in `mp-6-1-controls.test.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { connect, connectAsAdmin } from '../../packages/core-records/src/index.ts';
import { agentPath, type Controls } from './controls-fixture.ts';
import { authorised, post, tokenFor, type Answer } from './fixture.ts';
import { CHECK_ROWS, checksWorld, pickedUpOn } from './mp-6-1-checks-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one business, the checks recorded on its runs
describe.skipIf(serverUrl === undefined)('MP-6-1 checks and run controls', () => {
  let c: Controls;

  beforeAll(async () => {
    ({ c } = await checksWorld('mp_6_1_checks'));
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  const pickedUp = async (purpose: string) => await pickedUpOn(c, purpose);
  const checkRows = CHECK_ROWS;

  // eslint-disable-next-line max-lines-per-function -- the named test's cases, each on its own run
  describe('MP-6-1 check provenance', () => {
    it('writes the check under the live lease and names the agent that performed it', async () => {
      const work = await pickedUp('check_me');
      const answer = await c.asAgent(
        'task.check',
        { leaseId: work.leaseId, fence: work.fence, name: 'links resolve', outcome: 'passed' },
        work.credential,
      );
      expect(answer.status).toBe(200);
      const rows = await c.fixture.db.admin.execute<{
        readonly actor_id: string;
        readonly lease_id: string;
        readonly version_id: string;
        readonly outcome: string;
      }>(
        `select actor_id, lease_id, version_id, outcome from public.run_checks where task_id = $1`,
        [work.taskId],
      );
      expect(rows).toEqual([
        {
          actor_id: c.fixture.agentActorId,
          lease_id: work.leaseId,
          version_id: work.versionId,
          outcome: 'passed',
        },
      ]);
    });

    it('refuses a check with no live lease and writes nothing', async () => {
      const work = await pickedUp('check_after_handback');
      const handedBack = await c.asAgent(
        'task.handback',
        {
          leaseId: work.leaseId,
          fence: work.fence,
          outcome: 'completed',
          report: { wrote: 'nothing' },
        },
        work.credential,
      );
      expect(handedBack.status).toBe(200);
      const late = await c.asAgent(
        'task.check',
        { leaseId: work.leaseId, fence: work.fence, name: 'too late', outcome: 'passed' },
        work.credential,
      );
      expect(late.status).toBeGreaterThanOrEqual(400);
      expect(await c.count(checkRows, [work.taskId])).toBe(0);

      const invented = await c.asPerson('task.check', {
        leaseId: randomUUID(),
        fence: 1,
        name: 'no lease at all',
        outcome: 'passed',
      });
      expect(invented.status, JSON.stringify(invented.body)).toBe(403);
      expect(invented.body['code']).toBe('LEASE_NOT_OWNED');
      expect(await c.count(`select count(*)::text as n from public.run_checks`, [])).toBe(1);
    });

    it('refuses a person recording a check on the agent’s lease', async () => {
      const work = await pickedUp('not_the_holder');
      const answer = await c.asPerson('task.check', {
        leaseId: work.leaseId,
        fence: work.fence,
        name: 'from the side',
        outcome: 'passed',
      });
      expect(answer.status, JSON.stringify(answer.body)).toBe(403);
      expect(answer.body['code']).toBe('LEASE_NOT_OWNED');
      expect(await c.count(checkRows, [work.taskId])).toBe(0);
    });
  });

  // eslint-disable-next-line max-lines-per-function -- one ordered race and its lock holder
  describe('MP-6-1 check provenance under a race', () => {
    const waitingOnLocks = `select count(*)::text as n from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock'`;

    // The handback holds the lease lock while the check arrives, in that order
    // every time. Its lock set takes the lease, then the delegation, then the
    // reservation (`LOCK_ORDER`), so with the reservation row held elsewhere
    // the real handback stops holding the lease row; the check then waits on
    // that row, and runs once the handback has ended the lease and committed.
    // eslint-disable-next-line max-lines-per-function -- as above
    it('a check and a handback on one lease at once serialise on the lease lock', async () => {
      const work = await pickedUp('race_handback_first');
      const [held] = await c.fixture.db.admin.execute<{ readonly id: string }>(
        `select reservation_id as id from public.leases where id = $1`,
        [work.leaseId],
      );
      // Two requests at once need two connections: the fixture's pool has one.
      // Opened before the race, since one opened while the lock is polled was
      // seen to stall.
      const wide = connect(c.fixture.db.appUrl, { source: 'runtime', max: 3 });
      const api = c.fixture.compose(undefined, undefined, wide);
      const token = await tokenFor(c.fixture.agent.subject);
      const asAgent = async (name: string, body: Record<string, unknown>): Promise<Answer> =>
        await post(
          api,
          agentPath(name),
          { operationId: randomUUID(), ...body },
          { ...authorised(token), 'x-agent-delegation': work.credential },
        );
      const warm = await Promise.all(
        [1, 2, 3].map(async () => await asAgent('task.read', { recordId: work.taskId })),
      );
      expect(warm.map((answer) => answer.status)).toStrictEqual([200, 200, 200]);
      // The reservation's lock on a connection of its own: the boundary uses the fixture's.
      const holderUrl = new URL(String(serverUrl));
      holderUrl.pathname = `/${c.fixture.db.name}`;
      const holder = connectAsAdmin(holderUrl.toString(), { source: 'harness' });
      const lease = { leaseId: work.leaseId, fence: work.fence };
      let handedBack: Promise<Answer> | undefined;
      let checked: Promise<Answer> | undefined;
      try {
        await holder.transaction(async (execute) => {
          await execute(
            `select 1 from public.reservations where business_id = $1 and id = $2 for update`,
            [c.fixture.business, held?.id],
          );
          const queued = async (count: number, what: string): Promise<void> => {
            const deadline = Date.now() + 15_000;
            for (;;) {
              // eslint-disable-next-line no-await-in-loop -- polling until it waits
              const [row] = await execute<{ readonly n: string }>(waitingOnLocks, []);
              if (Number(row?.n) >= count) return;
              if (Date.now() > deadline) throw new Error(`the ${what} never waited`);
              // eslint-disable-next-line no-await-in-loop -- as above
              await new Promise((resolve) => {
                setTimeout(resolve, 50);
              });
            }
          };
          handedBack = asAgent('task.handback', {
            ...lease,
            outcome: 'completed',
            report: { wrote: 'x' },
          });
          await queued(1, 'handback');
          checked = asAgent('task.check', { ...lease, name: 'racing', outcome: 'passed' });
          await queued(2, 'check');
        });
        if (handedBack === undefined || checked === undefined) throw new Error('never sent');
        const back = await handedBack;
        const check = await checked;
        expect(back.status, JSON.stringify(back.body)).toBe(200);
        expect(check.status, JSON.stringify(check.body)).toBe(410);
        expect(check.body['code']).toBe('LEASE_EXPIRED');
        expect(await c.count(checkRows, [work.taskId])).toBe(0);
      } finally {
        await Promise.all([wide.close(), holder.close()]);
      }
    }, 60_000);
  });

  // eslint-disable-next-line max-lines-per-function -- the named test's cases, each on its own run
  describe('MP-6-1 check recorded', () => {
    it('each check is read back with its outcome against the version it ran on', async () => {
      const work = await pickedUp('checks_read_back');
      for (const [name, outcome] of [
        ['spelling', 'passed'],
        ['links resolve', 'failed'],
      ] as const) {
        // eslint-disable-next-line no-await-in-loop -- in order, so the read order is known
        const answer = await c.asAgent(
          'task.check',
          { leaseId: work.leaseId, fence: work.fence, name, outcome },
          work.credential,
        );
        expect(answer.status).toBe(200);
      }
      const read = await c.asPerson('task.read', { recordId: work.taskId });
      expect(read.status).toBe(200);
      const proposals = (read.body['task'] as { proposals: unknown }).proposals as {
        readonly versions: readonly {
          readonly versionId: string;
          readonly checks: readonly {
            name: string;
            outcome: string;
            performedByActorId: string;
          }[];
        }[];
      }[];
      const version = proposals
        .flatMap((p) => p.versions)
        .find((v) => v.versionId === work.versionId);
      expect(
        version?.checks.map(({ name, outcome, performedByActorId }) => ({
          name,
          outcome,
          performedByActorId,
        })),
      ).toStrictEqual([
        { name: 'spelling', outcome: 'passed', performedByActorId: c.fixture.agentActorId },
        { name: 'links resolve', outcome: 'failed', performedByActorId: c.fixture.agentActorId },
      ]);
    });

    it('refuses an outcome outside the three and a missing name, writing nothing', async () => {
      const work = await pickedUp('checks_refused');
      for (const body of [
        { name: 'x', outcome: 'maybe' },
        { name: '', outcome: 'passed' },
        { outcome: 'passed' },
      ]) {
        // eslint-disable-next-line no-await-in-loop -- one refusal at a time
        const answer = await c.asAgent(
          'task.check',
          { leaseId: work.leaseId, fence: work.fence, ...body },
          work.credential,
        );
        expect(answer.status).toBe(422);
      }
      expect(await c.count(checkRows, [work.taskId])).toBe(0);
    });
  });
});
