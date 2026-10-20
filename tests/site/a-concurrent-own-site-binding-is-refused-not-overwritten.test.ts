// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { bindPartySite } from '../../packages/core-records/src/site/party-sites.ts';
import { runBindOwnSite } from '../../scripts/ops/bind-own-site.ts';
import {
  ownSiteHooks,
  ownSiteOf,
  signedIn,
  subjects,
  serverUrl,
  type OwnSiteWorld,
} from './own-site-bind-step.fixture.ts';

const boundary = vi.hoisted(() => ({
  beforeWrite: undefined as undefined | (() => Promise<void>),
}));
vi.mock('../../packages/core-records/src/site/party-sites.ts', async (original) => {
  const actual =
    await original<typeof import('../../packages/core-records/src/site/party-sites.ts')>();
  return {
    ...actual,
    bindPartySite: async (...args: Parameters<typeof actual.bindPartySite>) => {
      const intervene = boundary.beforeWrite;
      boundary.beforeWrite = undefined;
      await intervene?.();
      return await actual.bindPartySite(...args);
    },
  };
});
let w: OwnSiteWorld;
ownSiteHooks((world) => {
  w = world;
});

it.skipIf(serverUrl === undefined)(
  'a concurrent own-site binding is refused rather than overwritten',
  async () => {
    const env = await signedIn(w, subjects.operator, 'agency');
    // The other transaction commits after the step's check has read the empty slot,
    // before the operator's real bindPartySite upsert. No store result is mocked.
    boundary.beforeWrite = async () => {
      const result = await w.db.app.withBusiness(w.agency, (tx) =>
        bindPartySite(
          tx,
          {
            partyId: null,
            repository: 'agency/existing-site',
            defaultBranch: 'stable',
            project: 'existing-project',
            pages: [],
          },
          w.operatorActor,
        ),
      );
      expect(result).toEqual({ ok: true });
    };
    const result = await runBindOwnSite(env);
    const saved = await ownSiteOf(w, w.agency);
    expect({ status: result.status, repository: saved.site?.['repository'] }).toEqual({
      status: 1,
      repository: 'agency/existing-site',
    });
  },
);
