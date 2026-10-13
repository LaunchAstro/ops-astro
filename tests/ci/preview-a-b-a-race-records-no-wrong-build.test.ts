// SPDX-License-Identifier: AGPL-3.0-only
//
// Each request pushes a commit made for it, with its version's tree, as the
// real push does (`gitPush`), so the branch holding version A again after B
// holds another commit than the first request's.
import { expect, it } from 'vitest';
import { requestPreview } from '../../scripts/ops/preview.ts';

it('an A to B to A preview race cannot record B as a build of A', async () => {
  const firstCommit = 'a'.repeat(40);
  const secondCommit = 'b'.repeat(40);
  let branch = '';
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- reassigned to the held hook's resolver
  let resolveFirst: (value: Response) => void = () => {
    throw new Error('no first hook');
  };
  let calls = 0;
  const built = new Map<string, string>();
  /** Each commit a push made, by the version it was made from. */
  const madeFrom = new Map<string, string>();
  const deps = {
    env: {
      PREVIEWS_VERCEL_PROJECT_ID: 'prj_previews01',
      VERCEL_PROJECT_ID: 'prj_staging01',
      PREVIEW_DEPLOY_HOOK: 'https://api.vercel.com/v1/integrations/deploy/prj_previews01/synthetic',
    },
    push: (version: string) => {
      branch = String(madeFrom.size).padStart(40, 'c');
      madeFrom.set(branch, version);
      return branch;
    },
    head: () => branch,
    post: () => {
      const job = `job${++calls}`;
      if (calls === 1)
        return new Promise<Response>((done) => {
          resolveFirst = done;
        });
      built.set(job, branch);
      return Promise.resolve(Response.json({ job: { id: job } }));
    },
  };
  const first = requestPreview({ version: firstCommit }, deps);
  const second = await requestPreview({ version: secondCommit }, deps);
  expect(second.kind).toBe('requested');
  built.set('job1', branch);
  const third = await requestPreview({ version: firstCommit }, deps);
  expect(third.kind).toBe('requested');
  resolveFirst(Response.json({ job: { id: 'job1' } }));
  for (const outcome of [await first, second, third]) {
    if (outcome.kind === 'requested') {
      expect(built.get(outcome.record.job), outcome.record.job).toBe(outcome.record.commit);
      expect(madeFrom.get(outcome.record.commit)).toBe(outcome.record.version);
    }
  }
});
