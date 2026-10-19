// SPDX-License-Identifier: AGPL-3.0-only
//
// The advance and the protection read act on a branch by name, so the runner's
// admission takes that name only as the configured site's default branch:
// anything else is `SITE_NOT_CONFIGURED`, before the host, the credential or the
// address. Mutant that turns it red: leave either name out of the default-branch
// set, and another branch is admitted.

import { expect, it } from 'vitest';
import { admitting, type ConfiguredSite } from '../../apps/site-runner/configured.ts';

const site: ConfiguredSite = {
  holder: '0b8d6f2e-1c4a-4e7b-9a3d-5f6e7d8c9b0a',
  repository: 'agency/site',
  defaultBranch: 'main',
  project: 'prj_site',
  pages: [{ pageUrl: 'https://agency.example/about/', path: 'src/pages/about.md' }],
};
const admit = admitting(site, {
  pageUrl: 'https://agency.example/about/',
  path: 'src/pages/about.md',
});

it.each(['site.source.advance', 'site.source.protection'])(
  'admits %s only on the default branch',
  (operation) => {
    const params = { repository: 'agency/site', sha: 'c0ffee01' };
    expect(admit(operation, { ...params, branch: 'main' })).toBeUndefined();
    for (const branch of ['staging', 'Main', 'main2', 'refs/heads/main'])
      expect(admit(operation, { ...params, branch })).toBe('SITE_NOT_CONFIGURED');
  },
);
