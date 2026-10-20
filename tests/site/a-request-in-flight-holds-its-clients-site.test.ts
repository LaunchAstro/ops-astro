// SPDX-License-Identifier: AGPL-3.0-only
//
// A request in flight and a change to its client's site, each on a connection
// of its own, the waiting side seen in pg_stat_activity. A move of the
// client's providers and a request are held in either order, so a move never
// commits after an open correction of the client does: the request first
// leaves the move refused; the move first leaves the request stored after it.
//
// A request that rolls back after its insert, wholly or to its savepoint as a
// refusal after the insert does, lets go of its page at once, and a waiting
// unbind goes through with nothing stored. Two requests on one page hold it
// together: an unbind waits for both, and is refused if either commits.

import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c80World, type C80World } from './c80-world.ts';
import { unbindPartySitePage } from '../../packages/core-records/src/site/party-sites.ts';
import type { TransactionQuery } from '../../packages/core-records/src/tenancy/transaction.ts';
import {
  BIND,
  correctionsOf,
  freshClient,
  held,
  insertOn,
  isStored,
  moveOf,
  onOwn,
  REQUEST,
  seenWaiting,
  UNBIND,
  waitSeen,
  type FreshClient,
} from './party-site-races.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('Request in flight: DATABASE_URL is unset, so nothing ran.');

let w: C80World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('inflight');
});

const unbindFirst = (client: FreshClient) => async (tx: TransactionQuery) =>
  await unbindPartySitePage(tx, client.partyId, client.pages[0].pageUrl);

describe.skipIf(serverUrl === undefined)("a request racing a move of its client's site", () => {
  it('makes the move wait for the request, then refuses it', async () => {
    const client = await freshClient(w);
    const request = held(w, insertOn(w, client, client.pages[0]));
    expect(isStored(await request.ready)).toBe(true);
    const moving = onOwn(w, moveOf(w, client.partyId));
    const waited = await seenWaiting(w, BIND).finally(() => request.release());
    expect(isStored(await request.done)).toBe(true);
    expect({ waited, moved: await moving }).toEqual({
      waited: true,
      moved: { ok: false, code: 'SITE_UNDER_CORRECTION' },
    });
  });

  it('makes the request wait for the move, then stores it after the move', async () => {
    const client = await freshClient(w);
    const move = held(w, moveOf(w, client.partyId));
    expect(await move.ready).toEqual({ ok: true });
    const requesting = onOwn(w, insertOn(w, client, client.pages[0]));
    const waited = await seenWaiting(w, REQUEST).finally(() => move.release());
    expect(await move.done).toEqual({ ok: true });
    expect({ waited, stored: isStored(await requesting) }).toEqual({ waited: true, stored: true });
  });

  it('stores the request once a move it waited for rolls back', async () => {
    const client = await freshClient(w);
    const move = held(w, moveOf(w, client.partyId));
    await move.ready;
    const requesting = onOwn(w, insertOn(w, client, client.pages[1]));
    const waited = await seenWaiting(w, REQUEST).finally(() => move.release(true));
    expect(await move.done).toBe('rolled back');
    expect({ waited, stored: isStored(await requesting) }).toEqual({ waited: true, stored: true });
  });
});

describe.skipIf(serverUrl === undefined)('a request rolled back after its insert', () => {
  it('lets the waiting unbind through, storing nothing', async () => {
    const client = await freshClient(w);
    const request = held(w, insertOn(w, client, client.pages[0]));
    await request.ready;
    const unbinding = onOwn(w, unbindFirst(client));
    await waitSeen(w, UNBIND).finally(() => request.release(true));
    expect(await request.done).toBe('rolled back');
    expect(await unbinding).toEqual({ ok: true });
    expect(await correctionsOf(w, client.partyId)).toBe(0);
  });

  it('lets go of the page at its savepoint, before its transaction ends', async () => {
    const client = await freshClient(w);
    const insert = insertOn(w, client, client.pages[0]);
    const request = held(w, async (tx) => {
      const [inserted, rolledBack] = [latchOf(), latchOf()];
      const kept = tx.savepoint(async (inner) => {
        await insert(inner);
        inserted.open();
        await rolledBack.passed;
        await inner.query('select 1 / 0');
      });
      await inserted.passed;
      return { kept, rollBack: rolledBack.open };
    });
    const { kept, rollBack } = await request.ready;
    const unbinding = onOwn(w, unbindFirst(client));
    await waitSeen(w, UNBIND).finally(rollBack);
    expect(await kept).toBe(false);
    expect(await unbinding).toEqual({ ok: true });
    request.release();
    await request.done;
    expect(await correctionsOf(w, client.partyId)).toBe(0);
  });
});

describe.skipIf(serverUrl === undefined)('two requests on one page while an unbind waits', () => {
  it('refuses the unbind when one of the two commits', async () => {
    const client = await freshClient(w);
    const first = held(w, insertOn(w, client, client.pages[0]));
    const second = held(w, insertOn(w, client, client.pages[0]));
    await Promise.all([first.ready, second.ready]);
    const unbinding = onOwn(w, unbindFirst(client));
    await waitSeen(w, UNBIND).finally(() => first.release(true));
    expect(await first.done).toBe('rolled back');
    await waitSeen(w, UNBIND).finally(() => second.release());
    await second.done;
    expect(await unbinding).toEqual({ ok: false, code: 'PAGE_UNDER_CORRECTION' });
    expect(await correctionsOf(w, client.partyId)).toBe(1);
  });

  it('unbinds the page when both roll back', async () => {
    const client = await freshClient(w);
    const first = held(w, insertOn(w, client, client.pages[0]));
    const second = held(w, insertOn(w, client, client.pages[0]));
    await Promise.all([first.ready, second.ready]);
    const unbinding = onOwn(w, unbindFirst(client));
    await waitSeen(w, UNBIND).finally(() => second.release(true));
    await waitSeen(w, UNBIND).finally(() => first.release(true));
    expect([await first.done, await second.done]).toEqual(['rolled back', 'rolled back']);
    expect(await unbinding).toEqual({ ok: true });
    expect(await correctionsOf(w, client.partyId)).toBe(0);
  });
});

/** A latch: `open` lets every `passed` through. */
function latchOf(): { readonly open: () => void; readonly passed: Promise<void> } {
  let open!: () => void;
  const passed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, passed };
}
