// SPDX-License-Identifier: AGPL-3.0-only
//
// A live correction is stored only for a page its own client's site holds.
// The party is the task's client, read in the insert, and the page is found on
// that client's site in the same statement (#1693: the request names the page,
// never its file). Another client's page and a page nobody holds are refused in
// the same words, NOT_FOUND, and nothing is stored for either. A site is bound once in the installation, and
// another business's binding never satisfies a request.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c80World, type C80World } from './c80-world.ts';
import { ABOUT, B_FILE, B_PAGE, PAGE } from './c80-sites.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  bindPartySite,
  readPartySite,
  type PartySiteRecord,
} from '../../packages/core-records/src/site/party-sites.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('Own-site page: DATABASE_URL is unset, so nothing ran.');

let w: C80World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('ownsite');
  await w.setApprover(w.ben.personId);
});

const storedIn = async (business: string): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly n: string }>(
        'select count(*)::text as n from public.live_corrections where business_id = $1',
        [business],
      )
    )[0]?.n,
  );

/** A refusal as the caller sees it, without the operation it answered. */
const seen = (result: unknown): unknown => {
  if (!isCommandRefusal(result as never)) return result;
  const { operationId: _operationId, ...rest } = result as unknown as Record<string, unknown>;
  return rest;
};

/** The client's site in `business`, changed by `change`, bound again; the store's answer. */
const rebind = async (
  business: string,
  partyId: string,
  actorId: string,
  change: (site: PartySiteRecord) => PartySiteRecord,
) =>
  await w.world.db.app.withBusiness(business, async (tx) => {
    const site = await readPartySite(tx, partyId);
    if (site === undefined) throw new Error('no site to bind again');
    return await bindPartySite(tx, change(site), actorId);
  });

describe.skipIf(serverUrl === undefined)("a request naming another client's page", () => {
  it("refuses a request on client A's task naming client B's bound page, storing nothing", async () => {
    const before = await storedIn(w.world.business);
    const crossed = await w.request(w.ava, { page: B_PAGE });
    expect(codeOf(crossed)).toBe('NOT_FOUND');
    expect(await storedIn(w.world.business)).toBe(before);
  });

  it('answers a page no client holds exactly as it answers another client’s page', async () => {
    const theirs = await w.request(w.ava, { page: B_PAGE });
    const nobodys = await w.request(w.ava, { page: 'https://agency.example/nobody/' });
    expect(codeOf(nobodys)).toBe('NOT_FOUND');
    expect(seen(nobodys)).toEqual(seen(theirs));
    const words = JSON.stringify(theirs);
    for (const foreign of [B_PAGE, B_FILE, w.partyB, 'client-b']) {
      expect(words).not.toContain(foreign);
    }
  });

  it('refuses a request that still names a file or a page address field', async () => {
    expect(codeOf(await w.request(w.ava, { path: B_FILE }))).toBe('COMMAND_BODY_INVALID');
    expect(codeOf(await w.request(w.ava, { pageUrl: B_PAGE }))).toBe('COMMAND_BODY_INVALID');
  });

  it.each([
    ['the page address in upper case', { page: PAGE.toUpperCase() }],
    ['the page address without its trailing slash', { page: PAGE.slice(0, -1) }],
    ['the page address percent-encoded', { page: PAGE.replace('about', '%61bout') }],
    ['the file path for the page', { page: ABOUT }],
  ])('refuses %s, storing nothing', async (_name, spelling) => {
    const before = await storedIn(w.world.business);
    expect(codeOf(await w.request(w.ava, spelling))).toBe('NOT_FOUND');
    expect(await storedIn(w.world.business)).toBe(before);
  });
});

describe.skipIf(serverUrl === undefined)("a request on the client's own page", () => {
  it("stores a request on the client's own page and file", async () => {
    const own = await w.request(w.ava);
    expect(codeOf(own)).toBe('not-a-refusal');
    expect(detailOf(own)['state']).toBe('requested');
  });

  it('refuses a request that names a party, which the server reads from the task', async () => {
    const crossed = await w.request(w.ava, { partyId: w.partyB, page: B_PAGE });
    expect(codeOf(crossed)).toBe('COMMAND_BODY_INVALID');
  });

  it('answers a replay of a refused request with the first answer', async () => {
    const operationId = randomUUID();
    const first = await w.request(w.ava, { operationId, page: B_PAGE });
    const again = await w.request(w.ava, { operationId, page: B_PAGE });
    expect(codeOf(first)).toBe('NOT_FOUND');
    expect(seen(again)).toEqual(seen(first));
  });

  it('binds two pages built from one file, and stores a request on either', async () => {
    const path = `src/pages/shared-${randomUUID().slice(0, 6)}.md`;
    const pages = ['one', 'two'].map((n) => `https://agency.example/${n}-${path.slice(-9, -3)}/`);
    const bound = await rebind(w.world.business, w.partyA, w.admin.actorId, (site) => ({
      ...site,
      pages: [...site.pages, ...pages.map((pageUrl) => ({ pageUrl, path }))],
    }));
    expect(bound).toEqual({ ok: true });
    for (const pageUrl of pages) {
      // oxlint-disable-next-line no-await-in-loop -- one request after the other
      expect(codeOf(await w.request(w.ava, { page: pageUrl }))).toBe('not-a-refusal');
    }
  });
});

describe.skipIf(serverUrl === undefined)("another business's site", () => {
  it("never lets another business's binding of the same page satisfy a request", async () => {
    const page = `https://agency.example/only-in-beta-${randomUUID().slice(0, 6)}/`;
    const path = 'src/pages/only-in-beta.md';
    const bound = await rebind(w.beta, w.betaParty, w.eve.actorId, (site) => ({
      ...site,
      pages: [...site.pages, { pageUrl: page, path }],
    }));
    expect(bound).toEqual({ ok: true });
    expect(codeOf(await w.request(w.ava, { page }))).toBe('NOT_FOUND');
  });

  it('reads no site of another business', async () => {
    const read = await w.world.db.app.withBusiness(
      w.beta,
      async (tx) => await readPartySite(tx, w.partyA),
    );
    expect(read).toBeUndefined();
  });
});

describe.skipIf(serverUrl === undefined)('a site bound once in the installation', () => {
  it("refuses a repository, in any case, or a project another business's site holds", async () => {
    const alpha = await w.world.db.app.withBusiness(
      w.world.business,
      async (tx) => await readPartySite(tx, w.partyA),
    );
    if (alpha === undefined) throw new Error('party A has no site');
    const asBeta = async (change: Partial<PartySiteRecord>) =>
      await rebind(w.beta, w.betaParty, w.eve.actorId, (site) => ({ ...site, ...change }));
    expect([
      await asBeta({ repository: alpha.repository }),
      await asBeta({ repository: alpha.repository.toUpperCase() }),
      await asBeta({ project: alpha.project }),
    ]).toEqual([
      { ok: false, code: 'SITE_BOUND_ELSEWHERE' },
      { ok: false, code: 'SITE_BOUND_ELSEWHERE' },
      { ok: false, code: 'SITE_BOUND_ELSEWHERE' },
    ]);
  });
});
