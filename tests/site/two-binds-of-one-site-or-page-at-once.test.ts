// SPDX-License-Identifier: AGPL-3.0-only
//
// Two binds at once, each on a connection of its own, the second seen waiting
// in pg_stat_activity behind the first. A repository or a project is bound
// once in the installation, so the second bind of one, in another business or
// in another client of the same business, is refused once the first commits
// and goes through if the first rolls back. A page names one client in a
// business, so the second client's bind of it is refused; another business's
// bind of the same address waits for nothing. The same bind twice at once
// leaves the site bound once, and refuses neither.
//
// A bind in flight holds the site row, and a request takes that row before
// its page, so a request waits for the bind: on a page the bind is adding, it
// is stored once the bind commits, as it is on a page already bound.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c80World, type C80World } from './c80-world.ts';
import {
  bindPartySite,
  type PartySiteRecord,
} from '../../packages/core-records/src/site/party-sites.ts';
import { connect } from '../../packages/core-records/src/index.ts';
import {
  BIND,
  correctionsOf,
  freshClient,
  held,
  insertOn,
  isStored,
  onOwn,
  PAGE_BIND,
  REQUEST,
  seenWaiting,
  waitSeen,
  type FreshClient,
} from './party-site-races.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('Two binds: DATABASE_URL is unset, so nothing ran.');

let w: C80World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('twobinds');
});

/** A client of beta's with no site yet. */
async function betaClient(): Promise<string> {
  const id = randomUUID();
  await w.world.db.admin.execute(
    `insert into public.clients (business_id, id, name, created_by_actor_id)
     values ($1, $2::uuid, $3, $4::uuid)`,
    [w.beta, id, `beta client ${id.slice(0, 8)}`, w.eve.actorId],
  );
  return id;
}

/** A client of alpha's with no site yet. */
async function alphaClient(): Promise<string> {
  const id = randomUUID();
  await w.world.db.admin.execute(
    `insert into public.clients (business_id, id, name, created_by_actor_id)
     values ($1, $2::uuid, $3, $4::uuid)`,
    [w.world.business, id, `alpha client ${id.slice(0, 8)}`, w.admin.actorId],
  );
  return id;
}

/** A site of its own for `partyId`, its names drawn fresh. */
const siteFor = (partyId: string): PartySiteRecord => {
  const own = randomUUID().slice(0, 8);
  return {
    partyId,
    repository: `twin/${own}`,
    defaultBranch: 'main',
    project: `prj_twin_${own}`,
    pages: [{ pageUrl: `https://${own}.example/`, path: `src/pages/${own}.md` }],
  };
};

/** The bind of `site` in `business`, on a connection of its own. */
async function bindIn(business: string, site: PartySiteRecord, actorId: string) {
  const own = connect(w.world.db.appUrl, { source: 'runtime' });
  try {
    return await own.withBusiness(business, async (tx) => await bindPartySite(tx, site, actorId));
  } finally {
    await own.close();
  }
}

/** `first` held open, `second` started behind it; the first let go, both answers. */
async function twoBinds(
  first: PartySiteRecord,
  second: { readonly business: string; readonly site: PartySiteRecord; readonly actorId: string },
  opts: { readonly waitsOn: RegExp; readonly rollback?: boolean },
) {
  const holding = held(w, async (tx) => await bindPartySite(tx, first, w.admin.actorId));
  expect(await holding.ready).toEqual({ ok: true });
  const binding = bindIn(second.business, second.site, second.actorId);
  const waited = await seenWaiting(w, opts.waitsOn).finally(() => holding.release(opts.rollback));
  return { waited, first: await holding.done, second: await binding };
}

describe.skipIf(serverUrl === undefined)('one repository or project bound twice at once', () => {
  it('refuses the second business its bind of the repository once the first commits', async () => {
    const first = siteFor(await alphaClient());
    const site = { ...siteFor(await betaClient()), repository: first.repository.toUpperCase() };
    const raced = await twoBinds(
      first,
      { business: w.beta, site, actorId: w.eve.actorId },
      {
        waitsOn: BIND,
      },
    );
    expect(raced).toEqual({
      waited: true,
      first: { ok: true },
      second: { ok: false, code: 'SITE_BOUND_ELSEWHERE' },
    });
  });

  it('binds the repository in the second business when the first rolls back', async () => {
    const first = siteFor(await alphaClient());
    const site = { ...siteFor(await betaClient()), repository: first.repository };
    const second = { business: w.beta, site, actorId: w.eve.actorId };
    const raced = await twoBinds(first, second, { waitsOn: BIND, rollback: true });
    expect(raced).toEqual({ waited: true, first: 'rolled back', second: { ok: true } });
  });

  it("refuses a second client of the business the first one's project", async () => {
    const first = siteFor(await alphaClient());
    const site = { ...siteFor(await alphaClient()), project: first.project };
    const second = { business: w.world.business, site, actorId: w.admin.actorId };
    expect(await twoBinds(first, second, { waitsOn: BIND })).toEqual({
      waited: true,
      first: { ok: true },
      second: { ok: false, code: 'SITE_BOUND_ELSEWHERE' },
    });
  });
});

describe.skipIf(serverUrl === undefined)('one page bound twice at once', () => {
  it('refuses a second client of the business the page once the first commits', async () => {
    const first = siteFor(await alphaClient());
    const site = { ...siteFor(await alphaClient()), pages: first.pages };
    const second = { business: w.world.business, site, actorId: w.admin.actorId };
    expect(await twoBinds(first, second, { waitsOn: PAGE_BIND })).toEqual({
      waited: true,
      first: { ok: true },
      second: { ok: false, code: 'PAGE_BOUND_ELSEWHERE' },
    });
  });

  it("binds the same address in another business's client without waiting", async () => {
    const first = siteFor(await alphaClient());
    const holding = held(w, async (tx) => await bindPartySite(tx, first, w.admin.actorId));
    await holding.ready;
    const site = { ...siteFor(await betaClient()), pages: first.pages };
    const second = await bindIn(w.beta, site, w.eve.actorId).finally(() => holding.release());
    expect([await holding.done, second]).toEqual([{ ok: true }, { ok: true }]);
  });

  it('binds one site once when the same bind runs twice at once, refusing neither', async () => {
    const client = await freshClient(w);
    const added = { pageUrl: `https://${randomUUID().slice(0, 8)}.example/`, path: 'src/x.md' };
    const again = { ...client.site, pages: [...client.site.pages, added] };
    const second = { business: w.world.business, site: again, actorId: w.admin.actorId };
    expect(await twoBinds(again, second, { waitsOn: BIND })).toEqual({
      waited: true,
      first: { ok: true },
      second: { ok: true },
    });
  });
});

describe.skipIf(serverUrl === undefined)('a bind racing a request', () => {
  it('makes a request on a page the bind has not committed wait for it, then stores it', async () => {
    const client = await freshClient(w);
    const page = { pageUrl: `https://${randomUUID().slice(0, 8)}.example/`, path: 'src/y.md' };
    const bindAdding = async (site: FreshClient['site'], tx: Parameters<typeof bindPartySite>[0]) =>
      await bindPartySite(tx, { ...site, pages: [page] }, w.admin.actorId);
    const holding = held(w, async (tx) => await bindAdding(client.site, tx));
    await holding.ready;
    const requesting = onOwn(w, insertOn(w, client, page));
    await waitSeen(w, REQUEST).finally(() => holding.release());
    expect(await holding.done).toEqual({ ok: true });
    expect(isStored(await requesting)).toBe(true);
    expect(await correctionsOf(w, client.partyId)).toBe(1);
  });

  it('makes a request on a bound page wait for a bind in flight, then stores it', async () => {
    const client = await freshClient(w);
    const page = { pageUrl: `https://${randomUUID().slice(0, 8)}.example/`, path: 'src/z.md' };
    const holding = held(
      w,
      async (tx) => await bindPartySite(tx, { ...client.site, pages: [page] }, w.admin.actorId),
    );
    await holding.ready;
    const requesting = onOwn(w, insertOn(w, client, client.pages[0]));
    await waitSeen(w, REQUEST).finally(() => holding.release());
    expect(await holding.done).toEqual({ ok: true });
    expect(isStored(await requesting)).toBe(true);
  });
});
