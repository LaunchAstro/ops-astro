// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { runStories } from '../../packages/ui/src/state/agent-run.ts';
import type { RunLineage } from '../../packages/ui/src/state/run-projection.ts';
import { clearingWorld, detailOf, ok } from '../commands/inbox-clearing-world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)('OW-108 real failed hand-back', () => {
  const w = clearingWorld('sol_ow108_failed');

  // Sol OW-108.1 criterion correctness, retitled by what it proves; its body is Sol's.
  it('a failed hand-back never reports successful completion', async () => {
    const p = await w.proposed('The worker cannot finish');
    const approved = detailOf(
      ok(
        await w.call(
          'task.decide',
          {
            gateId: p.gateId,
            versionId: p.versionId,
            decision: 'approve',
            note: 'go',
          },
          w.reviewerToken,
        ),
      ),
    );
    const picked = detailOf(
      ok(
        await w.call(
          'task.pickup',
          {
            reservationId: approved['reservationId'],
            leaseSeconds: 600,
          },
          w.writerToken,
        ),
      ),
    );
    ok(
      await w.call(
        'task.handback',
        {
          leaseId: picked['leaseId'],
          fence: picked['fence'],
          outcome: 'failed',
        },
        w.writerToken,
      ),
    );
    const read = ok(await w.call('task.read', { recordId: p.task.id }));
    const task = read.body['task'] as {
      proposals: RunLineage[];
      alerts: { kind: string }[];
    };
    expect(task.alerts.some((alert) => alert.kind === 'failed')).toBe(true);
    const [attempt] = await w.fixture.db.admin.execute<{ outcome: string }>(
      `select att.outcome from public.attempts att
        join public.reservations res on res.business_id = att.business_id and res.id = att.reservation_id
        join public.planned_runs r on r.business_id = res.business_id and r.id = res.run_id
        where r.task_id = $1`,
      [p.task.id],
    );
    expect(attempt?.outcome).toBe('failed');
    const story = runStories(task.proposals).at(-1);
    expect(story).toBeDefined();
    expect(story?.state).not.toBe('done');
  });
});
