// SPDX-License-Identifier: AGPL-3.0-only
//
// Every preview request puts its commit on the one preview branch, and the
// deploy hook builds whatever that branch holds when the hook reads it. Two
// requests at once can therefore move the branch under each other. A record
// says which commit a preview built, so a request whose hook may have read
// another request's commit must not record its own.
//
// The branch here is shared by both requests, and the hook reads it when it
// answers, which the first request's hook does only after the second request
// has finished.

import { expect, it } from 'vitest';
import { requestPreview } from '../../scripts/ops/preview.ts';

const PREVIEWS = 'prj_previews01';
const ENV = {
  PREVIEW_DEPLOY_HOOK: `https://api.vercel.com/v1/integrations/deploy/${PREVIEWS}/canary7c2f41hook`,
  PREVIEWS_VERCEL_PROJECT_ID: PREVIEWS,
  VERCEL_PROJECT_ID: 'prj_staging01',
};
const FIRST = 'a'.repeat(40);
const SECOND = 'b'.repeat(40);

it('two preview requests at once never record a commit their job did not build', async () => {
  let branch: string | undefined;
  const built = new Map<string, string | undefined>();
  const held: (() => void)[] = [];
  /** The hook builds the branch as it stands when it answers. */
  const answer = (): Response => {
    const id = `job${String(built.size + 1)}`;
    built.set(id, branch);
    return Response.json({ job: { id } });
  };
  const deps = {
    env: ENV,
    push: (version: string) => ((branch = version), true),
    head: () => branch,
    post: () =>
      new Promise<Response>((done) => {
        if (built.size === 0 && held.length === 0) held.push(() => done(answer()));
        else done(answer());
      }),
  };

  const first = requestPreview({ version: FIRST }, deps);
  await Promise.resolve();
  const second = await requestPreview({ version: SECOND }, deps);
  held[0]?.();
  const outcomes = [await first, second];

  const recorded = outcomes.flatMap((outcome) =>
    outcome.kind === 'requested' ? [[outcome.record.version, built.get(outcome.record.job)]] : [],
  );
  expect(recorded).toContainEqual([SECOND, SECOND]);
  for (const [version, commit] of recorded) expect(commit).toBe(version);
});
