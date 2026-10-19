// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof for S2090-3 on #2090 (copied unchanged but for its names): a
// proposal the budget cap refused is proposed again once the cap has room,
// under a new operation, and opens one lineage (#1717 R8a).
import { describe, expect, it } from 'vitest';
import { createWorker } from '../../apps/worker/worker.ts';
import { unproposed } from './compute-seam-world.ts';
import { s, useStopWorld, noDatabase } from './run-stop-world.ts';

useStopWorld('r8arefusal');
describe.skipIf(noDatabase)('a proposal refused for its budget', () => {
  it('is retried once the cap has room and opens one lineage', async () => {
    const { taskId, options, log } = await unproposed('room restored after refusal');
    await s.db.admin.execute(
      'update public.budget_caps set limit_minor = 1000 where business_id = $1',
      [s.business],
    );
    const worker = createWorker(options);
    expect(await worker.proposeOnce()).toMatchObject({
      refused: { code: 'PROPOSAL_SCOPE_EXCEEDED' },
    });
    await s.db.admin.execute(
      'update public.budget_caps set limit_minor = 1000000 where business_id = $1',
      [s.business],
    );
    const retried = await worker.proposeOnce();
    expect(
      retried,
      JSON.stringify({
        retried,
        proposals: log
          .filter((x) => x.verb === 'task.propose')
          .map((x) => ({ operationId: x.body['operationId'], status: x.status })),
      }),
    ).toHaveProperty('proposed');
    const [found] = await s.db.admin.execute<{ n: number }>(
      'select count(*)::int as n from public.proposal_lineages where business_id = $1 and task_id = $2',
      [s.business, taskId],
    );
    expect(found?.n).toBe(1);
  });
});
