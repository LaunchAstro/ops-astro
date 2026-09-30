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
import type { Controls } from './controls-fixture.ts';
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

  describe('MP-6-1 check provenance under a race', () => {
    it('a check and a handback on one lease at once serialise on the lease lock', async () => {
      for (let round = 0; round < 3; round += 1) {
        // eslint-disable-next-line no-await-in-loop -- one race at a time
        const work = await pickedUp(`race_${String(round)}`);
        // eslint-disable-next-line no-await-in-loop -- as above
        const [checked, handedBack] = await Promise.all([
          c.asAgent(
            'task.check',
            { leaseId: work.leaseId, fence: work.fence, name: 'racing', outcome: 'passed' },
            work.credential,
          ),
          c.asAgent(
            'task.handback',
            {
              leaseId: work.leaseId,
              fence: work.fence,
              outcome: 'completed',
              report: { wrote: 'x' },
            },
            work.credential,
          ),
        ]);
        expect(handedBack.status, JSON.stringify(handedBack.body)).toBe(200);
        expect([200, 401, 403, 410], JSON.stringify(checked.body)).toContain(checked.status);
        // Either the check won the lease lock and was written, or the handback
        // did and the check was refused with nothing written: never both, never a fault.
        // eslint-disable-next-line no-await-in-loop -- as above
        expect(await c.count(checkRows, [work.taskId])).toBe(checked.status === 200 ? 1 : 0);
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
