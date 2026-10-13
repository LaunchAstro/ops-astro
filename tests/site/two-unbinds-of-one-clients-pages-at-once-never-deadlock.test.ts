// SPDX-License-Identifier: AGPL-3.0-only
//
// Two unbinds of one client's pages at once, each on a connection of its own.
// The first unbinds page one and stays open; the second starts on page two and
// is seen waiting; the first then unbinds page two as well. Every unbind takes
// the client's site row before its page, so the second waits for the first
// rather than holding page two against it: both answer, and no deadlock.

import { beforeAll, describe, expect, it } from 'vitest';
import { connect } from '../../packages/core-records/src/index.ts';
import {
  readPartySite,
  unbindPartySitePage,
  type SiteWrite,
} from '../../packages/core-records/src/site/party-sites.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c80World, type C80World } from './c80-world.ts';
import { freshClient, inAlpha, lockWaiters, onOwn } from './party-site-races.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('Two unbinds at once: DATABASE_URL is unset, so nothing ran.');

let w: C80World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('twounbinds');
});

/** Until some statement of this database waits on a lock; false when none does. */
async function someoneWaits(): Promise<boolean> {
  for (let tries = 0; tries < 200; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling for the waiter
    if ((await lockWaiters(w)).length > 0) return true;
    // oxlint-disable-next-line no-await-in-loop -- polling for the waiter
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return false;
}

describe.skipIf(serverUrl === undefined)("two unbinds of one client's pages at once", () => {
  it('lets the second wait for the first, and both answer without a deadlock', async () => {
    const client = await freshClient(w);
    const [one, two] = client.pages;
    let secondPage!: () => void;
    const goOn = new Promise<void>((resolve) => {
      secondPage = resolve;
    });
    let firstHeld!: () => void;
    const holding = new Promise<void>((resolve) => {
      firstHeld = resolve;
    });
    const own = connect(w.world.db.appUrl, { source: 'runtime' });
    const first = own
      .withBusiness(w.world.business, async (tx): Promise<readonly SiteWrite[]> => {
        const unbound = await unbindPartySitePage(tx, client.partyId, one.pageUrl);
        firstHeld();
        await goOn;
        return [unbound, await unbindPartySitePage(tx, client.partyId, two.pageUrl)];
      })
      .finally(async () => {
        await own.close();
      });
    await holding;
    const second = onOwn(
      w,
      async (tx) => await unbindPartySitePage(tx, client.partyId, two.pageUrl),
    );
    const waited = await someoneWaits();
    secondPage();
    const [firstAnswer, secondAnswer] = await Promise.allSettled([first, second]);
    const failures = [firstAnswer, secondAnswer]
      .filter((each) => each.status === 'rejected')
      .map((each) => String((each as PromiseRejectedResult).reason));
    expect({ waited, failures }).toEqual({ waited: true, failures: [] });
    expect(firstAnswer).toEqual({ status: 'fulfilled', value: [{ ok: true }, { ok: true }] });
    expect(secondAnswer).toEqual({ status: 'fulfilled', value: { ok: true } });
    const site = await inAlpha(w, async (tx) => await readPartySite(tx, client.partyId));
    expect(site?.pages).toEqual([]);
  });
});
