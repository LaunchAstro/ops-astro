// SPDX-License-Identifier: AGPL-3.0-only
//
// #1693 on a real database: a site runner takes only the due corrections of
// its configured site's holder. Party B's own runner pins B's correction first
// (the control). Then party A's runner, in a pass with a due correction of
// each client, pins A's own and leaves B's `locating`, unread and unsettled,
// and B's runner pins it on its next pass. A runner never settles another
// client's correction `unlocated SITE_NOT_CONFIGURED`.
/* eslint-disable max-lines-per-function -- the two runners' passes share one case, in order */

import { describe, expect, it } from 'vitest';
import type { ConfiguredSite } from '../../apps/site-runner/configured.ts';
import { ABOUT, BEFORE, PAGE } from './c80-world.ts';
import { B_FILE, B_PAGE } from './c80-sites.ts';
import { serverUrl, w } from './c80-register-world.ts';
import {
  locateOnce,
  noneWaiting,
  requestOn,
  rowOf,
  sourceDouble,
  type SourceDouble,
} from './locate-world.ts';
import { useRunnerWorld } from './site-runner-world.ts';

useRunnerWorld();

/** Party B's site as bound, with its one page: the site B's own runner is configured for. */
async function clientBSite(): Promise<ConfiguredSite> {
  const [bound] = await w.world.db.admin.execute<{
    readonly repository: string;
    readonly default_branch: string;
    readonly project: string;
  }>(
    `select repository, default_branch, project from public.party_sites
      where business_id = $1 and holder = $2`,
    [w.world.business, w.partyB],
  );
  if (bound === undefined) throw new Error('clientBSite: party B has no site');
  return {
    holder: w.partyB,
    repository: bound.repository,
    defaultBranch: bound.default_branch,
    project: bound.project,
    pages: [{ pageUrl: B_PAGE, path: B_FILE }],
  };
}

/** B's source host: the team page holds the word a request names. */
const sourceOfB = (): SourceDouble => sourceDouble({ [B_FILE]: BEFORE });

describe.skipIf(serverUrl === undefined)(
  'a runner leaves another client’s corrections to their own runner',
  () => {
    it('pins its own client’s correction and leaves client B’s locating for B’s runner, which pins it', async () => {
      await noneWaiting();
      const siteB = await clientBSite();

      // The control: B's own runner places B's correction before A's runner takes a pass.
      const placed = await requestOn(B_PAGE, undefined, w.taskB);
      expect(await locateOnce(sourceOfB(), siteB)).toEqual([
        { correctionId: placed, outcome: 'requested' },
      ]);
      expect(await rowOf(placed)).toMatchObject({ state: 'requested', locate_code: null });

      // One due correction of each client; B's is the older, so it would come first.
      const theirs = await requestOn(B_PAGE, undefined, w.taskB);
      const ours = await requestOn(PAGE);
      const sourceOfA = sourceDouble({ [ABOUT]: BEFORE });

      expect(await locateOnce(sourceOfA)).toEqual([{ correctionId: ours, outcome: 'requested' }]);
      expect(await rowOf(ours)).toMatchObject({ state: 'requested', locate_code: null });
      // A's head, then A's file at it: B's file is never asked for.
      expect(sourceOfA.requests).toHaveLength(2);
      expect(sourceOfA.requests.some((asked) => asked.includes(B_FILE))).toBe(false);
      expect(await rowOf(theirs)).toMatchObject({
        state: 'locating',
        locate_code: null,
        check_failures: 0,
        version_id: null,
        next_in: null,
      });

      // B's own runner still finds it due, and pins it.
      expect(await locateOnce(sourceOfB(), siteB)).toEqual([
        { correctionId: theirs, outcome: 'requested' },
      ]);
      expect(await rowOf(theirs)).toMatchObject({ state: 'requested', locate_code: null });
    });
  },
);
