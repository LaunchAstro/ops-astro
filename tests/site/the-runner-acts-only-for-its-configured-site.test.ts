// SPDX-License-Identifier: AGPL-3.0-only
//
// #1693 on a real database: the site runner acts for its one configured site
// (`SITE_RUNNER_SITE`) and no other, whatever the token could reach. A
// correction whose holder's site was bound again elsewhere is settled
// `unlocated SITE_NOT_CONFIGURED` by the locate; one whose site was moved
// under it after its approval (a rebind forced past the triggers) runs nothing
// at dispatch, asks a person and hands its lease back; a waiting one bound to
// another project is put behind the rest, unstamped. None of them reaches the
// provider: custody is asked nothing.
/* eslint-disable max-lines-per-function -- the three cases share one world, in order */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { codeOf } from '../commands/agent-fixture.ts';
import { contentDigest } from '../../packages/core-connectors/src/index.ts';
import { bindPartySite } from '../../packages/core-records/src/index.ts';
import { custodySites } from '../../apps/site-runner/sites.ts';
import { ABOUT, BEFORE, PAGE } from './c80-world.ts';
import { PROJECT, REPOSITORY } from './c80-site-provider.ts';
import { serverUrl, w } from './c80-register-world.ts';
import { pinAsRunner } from './located.ts';
import { forceBinding, locateOnce, requestOn, rowOf, sourceDouble } from './locate-world.ts';
import { configuredSite, runnerOn, useRunnerWorld, world } from './site-runner-world.ts';

useRunnerWorld();

/** Pinned as the runner pins it, the file's digest the double's. */
async function pinned(id: string): Promise<void> {
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    await pinAsRunner(tx, id, { preImageDigest: contentDigest(BEFORE) });
  });
}

/** Party A's site bound again by its administrator, as the product binds one. */
async function rebind(repository: string): Promise<void> {
  const bound = await w.world.db.app.withBusiness(
    w.world.business,
    async (tx) =>
      await bindPartySite(
        tx,
        { ...configuredSite(), partyId: w.partyA, repository },
        w.admin.actorId,
      ),
  );
  expect(bound).toEqual({ ok: true });
}

describe.skipIf(serverUrl === undefined)(
  'the site runner acts only for its configured site',
  () => {
    it('settles a correction of a site bound again elsewhere unlocated, asking the provider nothing', async () => {
      // Correction 1 ends failed, so its holder's site is free to be bound again.
      const first = await requestOn(PAGE);
      await pinned(first);
      const { version_id: versionId } = await rowOf(first);
      expect(codeOf(await w.approve(w.ben, first, String(versionId)))).toBe('not-a-refusal');
      await w.world.db.admin.execute(
        `update public.live_corrections set state = 'failed', revision = revision + 1 where id = $1`,
        [first],
      );
      await rebind(`agency/site-b-${randomUUID().slice(0, 8)}`);
      const second = await requestOn(PAGE);
      const double = sourceDouble({ [ABOUT]: BEFORE });

      expect(await locateOnce(double)).toEqual([
        { correctionId: second, outcome: 'SITE_NOT_CONFIGURED' },
      ]);
      expect(double.requests).toEqual([]);
      expect(await rowOf(second)).toMatchObject({
        state: 'unlocated',
        locate_code: 'SITE_NOT_CONFIGURED',
        version_id: null,
      });
      await rebind(REPOSITORY);
    });

    it('runs nothing at dispatch for a correction whose site moved after its approval, and asks a person', async () => {
      const id = await requestOn(PAGE);
      const located = sourceDouble({ [ABOUT]: BEFORE });
      expect(await locateOnce(located)).toEqual([{ correctionId: id, outcome: 'requested' }]);
      const { version_id: versionId } = await rowOf(id);
      expect(codeOf(await w.approve(w.ben, id, String(versionId)))).toBe('not-a-refusal');
      // The site is held while the correction is open; the seed steps round that.
      await forceBinding({ repository: `agency/site-c-${randomUUID().slice(0, 8)}` });
      const counted = sourceDouble({ [ABOUT]: BEFORE });
      const given = { ...world(), sites: custodySites(counted.ports, configuredSite()) };
      const { runner, released } = runnerOn(id, given);

      expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'SITE_NOT_CONFIGURED' }]);
      expect(given.raised).toEqual(['SITE_NOT_CONFIGURED']);
      expect(released).toEqual([id]);
      expect(counted.requests).toEqual([]);
      expect(given.site.sent).toEqual([]);
      expect(await w.stateOf(id)).toBe('approved');
      expect(await w.receiptsOf(id)).toBe(0);
      await forceBinding({ repository: REPOSITORY });
    });

    it('puts a waiting correction bound to another project behind the rest, unstamped and unread', async () => {
      const id = await requestOn(PAGE);
      await pinned(id);
      const before = await rowOf(id);
      await forceBinding({ project: `prj_elsewhere_${randomUUID().slice(0, 8)}` });
      const double = sourceDouble({ [ABOUT]: BEFORE });

      expect(await locateOnce(double)).toEqual([
        { correctionId: id, outcome: 'SITE_NOT_CONFIGURED' },
      ]);
      expect(double.requests).toEqual([]);
      const after = await rowOf(id);
      expect(after).toMatchObject({ state: 'requested', verified_at: before.verified_at });
      expect(after.next_in).toBeGreaterThan(10);
      await forceBinding({ project: PROJECT });
    });
  },
);
