// SPDX-License-Identifier: AGPL-3.0-only
//
// #1693, gap 1: while a correction is `locating`, its holder's site holds
// still, so the pin can only name the binding the request resolved. A move of
// the site's providers, or an unbind of its page, is refused while it locates;
// a pin that finds the site row naming another repository (forced past the
// freeze) settles `unlocated SITE_CHANGED`, unpinned; and a pin racing an
// unbind in flight (second connection, the wait seen in pg_stat_activity)
// either pins first and the unbind is refused, never a pin on a gone page.

import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { pinLocated, type ConfiguredSite } from '../../packages/core-records/src/site/locate.ts';
import { unbindPartySitePage } from '../../packages/core-records/src/index.ts';
import { c80World, type C80World } from './c80-world.ts';
import {
  freshClient,
  held,
  inAlpha,
  insertOn,
  moveOf,
  seenWaiting,
  type FreshClient,
} from './party-site-races.ts';
import { TEST_PIN } from './located.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('Locate freeze: DATABASE_URL is unset, so nothing ran.');

let w: C80World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('freeze');
}, 120_000);

const configured = (client: FreshClient): ConfiguredSite => ({
  holder: client.partyId,
  repository: client.site.repository,
  defaultBranch: client.site.defaultBranch,
  project: client.site.project,
  pages: client.pages,
});

/** A request on the client's first page, stored `locating`. */
async function locatingOn(client: FreshClient): Promise<string> {
  const stored = await inAlpha(w, insertOn(w, client, client.pages[0]));
  if ('code' in stored) throw new Error(`request refused ${stored.code}`);
  expect(stored.state).toBe('locating');
  return stored.id;
}

const pin = (id: string) => ({ id, versionId: crypto.randomUUID(), ...TEST_PIN });

const rowOf = async (id: string) =>
  (
    await w.world.db.admin.execute<{
      readonly state: string;
      readonly locate_code: string | null;
      readonly base_revision: string | null;
    }>('select state, locate_code, base_revision from public.live_corrections where id = $1', [id])
  )[0];

describe.skipIf(serverUrl === undefined)('a locating correction freezes its site binding', () => {
  it('refuses a move of the site to another repository, and an unbind of its page', async () => {
    const client = await freshClient(w);
    await locatingOn(client);
    const moved = await inAlpha(w, moveOf(w, client.partyId));
    expect(moved).toStrictEqual({ ok: false, code: 'SITE_UNDER_CORRECTION' });
    const unbound = await inAlpha(
      w,
      async (tx) => await unbindPartySitePage(tx, client.partyId, client.pages[0].pageUrl),
    );
    expect(unbound).toStrictEqual({ ok: false, code: 'PAGE_UNDER_CORRECTION' });
  });
});

describe.skipIf(serverUrl === undefined)('a locating correction freezes its site binding', () => {
  it('settles a pin unlocated SITE_CHANGED when the site row names another repository', async () => {
    const client = await freshClient(w);
    const id = await locatingOn(client);
    await w.world.db.admin.execute(
      `with replica as (select set_config('session_replication_role', 'replica', true))
       update public.party_sites set repository = 'elsewhere/b' from replica
        where business_id = $1 and holder = $2`,
      [w.world.business, client.partyId],
    );
    const answer = await inAlpha(
      w,
      async (tx) => await pinLocated(tx, configured(client), pin(id)),
    );
    expect(answer).toBe('unlocated');
    expect(await rowOf(id)).toStrictEqual({
      state: 'unlocated',
      locate_code: 'SITE_CHANGED',
      base_revision: null,
    });
  });
});

describe.skipIf(serverUrl === undefined)('a locating correction freezes its site binding', () => {
  it('pins before an unbind in flight, which then waits and is refused', async () => {
    const client = await freshClient(w);
    const id = await locatingOn(client);
    const pinning = held(w, async (tx) => await pinLocated(tx, configured(client), pin(id)));
    expect(await pinning.ready).toBe('pinned');
    const unbinding = inAlpha(
      w,
      async (tx) => await unbindPartySitePage(tx, client.partyId, client.pages[0].pageUrl),
    );
    const waited = await seenWaiting(w, /from public\.party_sites/u).finally(() =>
      pinning.release(),
    );
    expect(waited).toBe(true);
    await pinning.done;
    expect(await unbinding).toStrictEqual({ ok: false, code: 'PAGE_UNDER_CORRECTION' });
    expect((await rowOf(id))?.state).toBe('requested');
  });
});
