// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-1, the run's checks and the run controls' authority, through the real
// boundary and a fresh Postgres.
//
// `task.check` is how a run records a check it performed (CS-16.3). It is a
// system write: the caller is the holder of the run's live lease, and the row
// names that holder as the agent that performed it and the version the lease
// works. With no live lease there is nothing to write under, so it is refused
// and nothing is written (TR-S-R4-9).
//
// `task.cancel` and `task.restart` are decisions about a run, so they take
// `gate:decide` (the catalogue key; in the grant model, `decide` on the task
// collection), which an agent never holds. A person holding `write` alone is
// refused and nothing changes.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { createControls, type Controls } from './controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('MP-6-1 checks and run controls', () => {
  let c: Controls;
  let writer: Member;

  beforeAll(async () => {
    c = await createControls('mp_6_1_checks');
    writer = await enrol(c.fixture.db.app, c.fixture.business, 'writer');
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      await grantTo(tx, writer, 'read');
      await grantTo(tx, writer, 'write');
    });
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  async function pickedUp(purpose: string) {
    const task = await c.createTask(`a task for ${purpose}`);
    const proposal = await c.propose(task.id, task.revision, purpose);
    const reservationId = await c.approve(proposal);
    const picked = await c.pickup(reservationId, 600);
    return {
      taskId: task.id,
      lineageId: String(proposal['lineageId']),
      versionId: String(proposal['versionId']),
      leaseId: String(picked['leaseId']),
      fence: Number(picked['fence']),
      credential: String(picked['credential']),
    };
  }

  const checkRows = `select count(*)::text as n from public.run_checks where task_id = $1`;

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

  describe('MP-6-1 refusal gate:decide', () => {
    it('refuses cancel and restart to a person holding write without decide, nothing changed', async () => {
      const task = await c.createTask('a run a writer may not stop');
      const proposal = await c.propose(task.id, task.revision, 'writer_cannot_cancel');
      await c.approve(proposal);
      const lineageId = String(proposal['lineageId']);
      const cancel = await c.asPerson(
        'task.cancel',
        { recordId: task.id, lineageId, reason: 'a writer tries' },
        writer,
      );
      expect(cancel.status).toBe(403);
      const live = `select count(*)::text as n from public.proposal_lineages where id = $1 and state = 'live'`;
      expect(await c.count(live, [lineageId])).toBe(1);

      // The holder of decide cancels it; then the writer may not restart it.
      expect(
        (await c.asPerson('task.cancel', { recordId: task.id, lineageId, reason: 'stopped' }))
          .status,
      ).toBe(200);
      const restart = await c.asPerson('task.restart', { recordId: task.id, lineageId }, writer);
      expect(restart.status).toBe(403);
      expect(
        await c.count(
          `select count(*)::text as n from public.proposal_lineages where restarts_lineage_id = $1`,
          [lineageId],
        ),
      ).toBe(0);
      const restarted = await c.asPerson('task.restart', { recordId: task.id, lineageId });
      expect(restarted.status).toBe(200);
    });

    it('refuses the agent cancelling the run it works, whatever it holds', async () => {
      const work = await pickedUp('agent_cannot_cancel');
      const answer = await c.asAgent(
        'task.cancel',
        { recordId: work.taskId, lineageId: work.lineageId, reason: 'the agent tries' },
        work.credential,
      );
      expect(answer.status).toBeGreaterThanOrEqual(400);
      expect(
        await c.count(
          `select count(*)::text as n from public.proposal_lineages where id = $1 and state = 'live'`,
          [work.lineageId],
        ),
      ).toBe(1);
    });
  });
});
