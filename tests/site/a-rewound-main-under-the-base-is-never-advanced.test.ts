// SPDX-License-Identifier: AGPL-3.0-only
//
// Proves the publish never advances a main that was rewound below the approved
// base: main's head must be the base revision, or nothing is sent on main and
// the publish is refused BASE_MOVED, on a real Git repository.
// Mutant that turns it red once built: drop the head-equals-base check, and the
// fast-forward from the rewound commit to the seam head succeeds and brings
// back src/pages/old.md, the file the rewrite removed.

import { afterEach, expect, test } from 'vitest';
import { mergeAndFind, versionDigestOf } from '../../packages/core-connectors/src/index.ts';
import { AFTER, BEFORE, REPOSITORY, SEAM, VERSION_PIN, binding } from './c80-site-provider.ts';
import { ENFORCED, realGitSite, type RealGitSite } from './real-git-site.ts';

let site: RealGitSite | undefined;
afterEach(() => site?.dispose());

test('a main rewound under the approved base is refused BASE_MOVED and never advanced', async () => {
  const git = realGitSite();
  site = git;
  const a = git.commit(undefined, { 'src/pages/about.md': BEFORE }, 'About page');
  const b = git.commit(a, { 'src/pages/old.md': 'An old page.\n' }, 'Old page');
  const h = git.commit(b, { 'src/pages/about.md': AFTER }, `Correction ${SEAM}`);
  git.rewrite(SEAM, h);
  // The rewrite made before protection was turned on: main back at A, B gone from it.
  git.rewrite('main', a);
  git.protection['main'] = ENFORCED;

  const pin = { ...VERSION_PIN, baseRevision: b };
  const versionDigest = versionDigestOf(pin);
  const bound = {
    ...binding,
    baseRevision: b,
    proposal: { ...binding.proposal, head: h, versionDigest },
  };
  const result = await mergeAndFind(bound, { ...pin, versionDigest }, git.deps);

  const onMain = git.sent.filter(
    (sent) =>
      sent.method === 'PATCH' ||
      (sent.method === 'PUT' &&
        sent.target === `/repos/${REPOSITORY}/contents/src/pages/about.md` &&
        sent.body['branch'] === 'main'),
  );
  expect(onMain.map((sent) => `${sent.method} ${sent.target}`)).toEqual([]);
  expect(result).toEqual({ kind: 'refused', code: 'BASE_MOVED' });
  expect(git.head('main')).toBe(a);
  expect(git.fileAt('main', 'src/pages/old.md')).toBeUndefined();
});
