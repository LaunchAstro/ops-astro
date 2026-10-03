// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { requestPreview } from '../../scripts/ops/preview.ts';

it('concurrent preview requests build the commit each record names', async () => {
  const versionA = 'a'.repeat(40);
  const versionB = 'b'.repeat(40);
  let branchHead = '';
  let releaseFirst!: () => void;
  const firstDelivery = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const built = new Map<string, string>();
  let posts = 0;
  const deps = {
    env: {
      PREVIEWS_VERCEL_PROJECT_ID: 'prj_sol065preview',
      VERCEL_PROJECT_ID: 'prj_sol065staging',
      PREVIEW_DEPLOY_HOOK:
        'https://api.vercel.com/v1/integrations/deploy/prj_sol065preview/syntheticHook',
    },
    push: (version: string) => {
      branchHead = version;
      return true;
    },
    post: async () => {
      const job = `job${++posts}`;
      // The first HTTP request is in flight while the second caller pushes.
      if (job === 'job1') await firstDelivery;
      built.set(job, branchHead);
      return Response.json({ job: { id: job } });
    },
  };
  const first = requestPreview({ version: versionA }, deps);
  const secondRequest = requestPreview({ version: versionB }, deps);
  releaseFirst();
  const [firstOutcome, second] = await Promise.all([first, secondRequest]);
  expect(firstOutcome.kind).toBe('requested');
  if (firstOutcome.kind !== 'requested') throw new Error('first fixture request refused');
  // A concurrent request may safely be refused or queued behind the first.
  if (second.kind === 'requested') expect(built.get(second.record.job)).toBe(second.record.version);
  expect(built.get(firstOutcome.record.job)).toBe(firstOutcome.record.version);
});
