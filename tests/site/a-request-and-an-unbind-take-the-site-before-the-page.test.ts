// SPDX-License-Identifier: AGPL-3.0-only
//
// A request and an unbind of the same client's page take the client's site
// row before the page, both of them. An unbind holding the site keeps a
// request waiting on it, then deletes the page and commits; the request then
// finds no page and is refused, with no deadlock between the two.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unbindPartySitePage } from '../../packages/core-records/src/site/party-sites.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c80World, type C80World } from './c80-world.ts';
import { freshClient, held, insertOn, onOwn, REQUEST, waitSeen } from './party-site-races.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('A request and an unbind: DATABASE_URL is unset, so nothing ran.');

let w: C80World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('sitefirst');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

/** A failure's SQLSTATE where it has one, else its text. */
function fault(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) return String(error.code);
  return String(error);
}

describe.skipIf(serverUrl === undefined)("a request and an unbind of one client's page", () => {
  it('lets the request wait on the site the unbind holds, then refuses it', async () => {
    const client = await freshClient(w);
    // The store's unbind, paused after it takes the site and before it deletes the page.
    const unbinder = held(w, async (tx) => {
      await tx.query(
        `select 1 from public.party_sites
          where business_id = $1 and party_id = $2::uuid for no key update`,
        [tx.businessId, client.partyId],
      );
      return tx;
    });
    const tx = await unbinder.ready;
    const request = onOwn(w, insertOn(w, client, client.pages[0])).then(
      (value) => ({ value }),
      (error: unknown) => ({ error: fault(error) }),
    );
    await waitSeen(w, REQUEST);
    const unbound = await unbindPartySitePage(tx, client.partyId, client.pages[0].pageUrl).then(
      (value) => ({ value }),
      (error: unknown) => ({ error: fault(error) }),
    );
    unbinder.release();
    const ended = await unbinder.done.then(
      () => 'committed',
      (error: unknown) => fault(error),
    );
    expect({ unbound, ended, asked: await request }).toEqual({
      unbound: { value: { ok: true } },
      ended: 'committed',
      asked: { value: { ok: false, code: 'PAGE_NOT_FOUND' } },
    });
  });
});
