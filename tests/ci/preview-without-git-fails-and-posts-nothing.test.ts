// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { gitPush, requestPreview } from '../../scripts/ops/preview.ts';

it('an unavailable git executable returns a failed preview', async () => {
  const emptyPath = mkdtempSync(join(tmpdir(), 'proof-no-git-'));
  try {
    let posts = 0;
    await expect(
      requestPreview(
        { version: 'a'.repeat(40) },
        {
          env: {
            PREVIEWS_VERCEL_PROJECT_ID: 'prj_previews01',
            PREVIEW_DEPLOY_HOOK:
              'https://api.vercel.com/v1/integrations/deploy/prj_previews01/synthetic',
          },
          push: (version) => gitPush(version, { PATH: emptyPath }),
          // oxlint-disable-next-line unicorn/no-useless-undefined -- the branch cannot be read
          head: () => undefined,
          post: () => {
            posts++;
            return Promise.resolve(Response.json({ job: { id: 'job1' } }));
          },
        },
      ),
    ).resolves.toMatchObject({ kind: 'failed' });
    expect(posts).toBe(0);
  } finally {
    rmSync(emptyPath, { recursive: true, force: true });
  }
});
