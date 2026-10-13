// SPDX-License-Identifier: AGPL-3.0-only
//
// A live correction is stored only for a page its own client's site holds.
// The party is the task's client, read in the insert; the page and its source
// file are read in the same statement, as one pair, spelt exactly. Another
// client's page and a page nobody holds are refused in the same words, and
// nothing is stored for either. A site is bound once in the installation, and
// a page under a correction that may still reach the site is never unbound.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { ABOUT, PAGE, B_FILE, B_PAGE, c80World, type C80World } from './c80-world.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { connect, insertLiveCorrection } from '../../packages/core-records/src/index.ts';
import {
  bindPartySite,
  readPartySite,
  unbindPartySitePage,
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

describe.skipIf(serverUrl === undefined)("a request names a page of its own client's site", () => {
  it("refuses a request on client A's task naming client B's bound page, storing nothing", async () => {
    const before = await storedIn(w.world.business);
    const crossed = await w.request(w.ava, { pageUrl: B_PAGE, path: B_FILE });
    expect(codeOf(crossed)).toBe('PAGE_OUTSIDE_PARTY_SITE');
    expect(await storedIn(w.world.business)).toBe(before);
  });

  it('answers a page no client holds exactly as it answers another client’s page', async () => {
    const theirs = await w.request(w.ava, { pageUrl: B_PAGE, path: B_FILE });
    const nobodys = await w.request(w.ava, {
      pageUrl: 'https://agency.example/nobody/',
      path: 'src/pages/nobody.md',
    });
    expect(codeOf(nobodys)).toBe('PAGE_OUTSIDE_PARTY_SITE');
    expect(seen(nobodys)).toEqual(seen(theirs));
    const words = JSON.stringify(theirs);
    for (const foreign of [B_PAGE, B_FILE, w.partyB, 'client-b']) {
      expect(words).not.toContain(foreign);
    }
  });

  it("refuses the client's own page with its other client's file, and the reverse", async () => {
    expect(codeOf(await w.request(w.ava, { path: B_FILE }))).toBe('PAGE_OUTSIDE_PARTY_SITE');
    expect(codeOf(await w.request(w.ava, { pageUrl: B_PAGE }))).toBe('PAGE_OUTSIDE_PARTY_SITE');
  });

  it("stores a request on the client's own page and file", async () => {
    const own = await w.request(w.ava);
    expect(codeOf(own)).toBe('not-a-refusal');
    expect(detailOf(own)['state']).toBe('requested');
  });

  it.each([
    ['the page in upper case', { pageUrl: PAGE.toUpperCase() }],
    ['the page without its trailing slash', { pageUrl: PAGE.slice(0, -1) }],
    ['the page percent-encoded', { pageUrl: PAGE.replace('about', '%61bout') }],
    ['the file in another case', { path: ABOUT.replace('about', 'About') }],
  ])('refuses %s, storing nothing', async (_name, spelling) => {
    const before = await storedIn(w.world.business);
    expect(codeOf(await w.request(w.ava, spelling))).toBe('PAGE_OUTSIDE_PARTY_SITE');
    expect(await storedIn(w.world.business)).toBe(before);
  });

  it('keeps the refusal of a client that is not the task’s ahead of the page', async () => {
    const crossed = await w.request(w.ava, { partyId: w.partyB, pageUrl: B_PAGE, path: B_FILE });
    expect(codeOf(crossed)).toBe('CORRECTION_PARTY_MISMATCH');
  });

  it('answers a replay of a refused request with the first answer', async () => {
    const operationId = randomUUID();
    const first = await w.request(w.ava, { operationId, pageUrl: B_PAGE, path: B_FILE });
    const again = await w.request(w.ava, { operationId, pageUrl: B_PAGE, path: B_FILE });
    expect(codeOf(first)).toBe('PAGE_OUTSIDE_PARTY_SITE');
    expect(seen(again)).toEqual(seen(first));
  });
});

describe.skipIf(serverUrl === undefined)('a site is bound in one business', () => {
  it("never lets another business's binding of the same page satisfy a request", async () => {
    const page = `https://agency.example/only-in-beta-${randomUUID().slice(0, 6)}/`;
    const path = 'src/pages/only-in-beta.md';
    await w.world.db.app.withBusiness(w.beta, async (tx) => {
      const site = await readPartySite(tx, w.betaParty);
      expect(site).toBeDefined();
      await bindPartySite(
        tx,
        { ...site!, pages: [...site!.pages, { pageUrl: page, path }] },
        w.eve.actorId,
      );
    });
    expect(codeOf(await w.request(w.ava, { pageUrl: page, path }))).toBe('PAGE_OUTSIDE_PARTY_SITE');
  });

  it("refuses to bind a repository or project another business's site holds", async () => {
    const alphaSite = await w.world.db.app.withBusiness(
      w.world.business,
      async (tx) => await readPartySite(tx, w.partyA),
    );
    const refusals = await w.world.db.app.withBusiness(w.beta, async (tx) => {
      const site = await readPartySite(tx, w.betaParty);
      return [
        await bindPartySite(tx, { ...site!, repository: alphaSite!.repository }, w.eve.actorId),
        await bindPartySite(tx, { ...site!, project: alphaSite!.project }, w.eve.actorId),
      ];
    });
    expect(refusals).toEqual([
      { ok: false, code: 'SITE_BOUND_ELSEWHERE' },
      { ok: false, code: 'SITE_BOUND_ELSEWHERE' },
    ]);
  });

  it('refuses a repository another business holds, spelt in another case', async () => {
    const alphaSite = await w.world.db.app.withBusiness(
      w.world.business,
      async (tx) => await readPartySite(tx, w.partyA),
    );
    const refused = await w.world.db.app.withBusiness(w.beta, async (tx) => {
      const site = await readPartySite(tx, w.betaParty);
      const repository = alphaSite!.repository.toUpperCase();
      return await bindPartySite(tx, { ...site!, repository }, w.eve.actorId);
    });
    expect(refused).toEqual({ ok: false, code: 'SITE_BOUND_ELSEWHERE' });
  });

  it('binds two pages built from one file, and stores a request on either', async () => {
    const path = `src/pages/shared-${randomUUID().slice(0, 6)}.md`;
    const pages = [
      `https://agency.example/one-${path.length}/`,
      `https://agency.example/two-${path.length}/`,
    ];
    const bound = await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      const site = await readPartySite(tx, w.partyA);
      return await bindPartySite(
        tx,
        { ...site!, pages: [...site!.pages, ...pages.map((pageUrl) => ({ pageUrl, path }))] },
        w.admin.actorId,
      );
    });
    expect(bound).toEqual({ ok: true });
    for (const pageUrl of pages) {
      // oxlint-disable-next-line no-await-in-loop -- one request after the other
      expect(codeOf(await w.request(w.ava, { pageUrl, path }))).toBe('not-a-refusal');
    }
  });

  it('reads no site of another business', async () => {
    const read = await w.world.db.app.withBusiness(
      w.beta,
      async (tx) => await readPartySite(tx, w.partyA),
    );
    expect(read).toBeUndefined();
  });
});

describe.skipIf(serverUrl === undefined)('unbinding a page', () => {
  const bindExtra = async (path: string): Promise<string> => {
    const page = `https://agency.example/${path.replace(/\W/gu, '-')}/`;
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      const site = await readPartySite(tx, w.partyA);
      await bindPartySite(
        tx,
        { ...site!, pages: [...site!.pages, { pageUrl: page, path }] },
        w.admin.actorId,
      );
    });
    return page;
  };
  const unbind = async (page: string) =>
    await w.world.db.app.withBusiness(
      w.world.business,
      async (tx) => await unbindPartySitePage(tx, w.partyA, page),
    );

  it('refuses to unbind a page under a requested or approved correction', async () => {
    const path = `src/pages/approved-${randomUUID().slice(0, 6)}.md`;
    const page = await bindExtra(path);
    const asked = detailOf(await w.request(w.ava, { pageUrl: page, path }));
    expect(await unbind(page)).toEqual({ ok: false, code: 'PAGE_UNDER_CORRECTION' });
    const approved = await w.approve(
      w.ben,
      String(asked['correctionId']),
      String(asked['versionId']),
    );
    expect(codeOf(approved)).toBe('not-a-refusal');
    expect(await unbind(page)).toEqual({ ok: false, code: 'PAGE_UNDER_CORRECTION' });
  });

  it('unbinds a page once its correction is rejected, and refuses the next request', async () => {
    const path = `src/pages/rejected-${randomUUID().slice(0, 6)}.md`;
    const page = await bindExtra(path);
    const asked = detailOf(await w.request(w.ava, { pageUrl: page, path }));
    const rejected = await w.as(w.ben, {
      command: 'live_correction.decide',
      correctionId: asked['correctionId'],
      versionId: asked['versionId'],
      decision: 'reject',
    });
    expect(codeOf(rejected)).toBe('not-a-refusal');
    expect(await unbind(page)).toEqual({ ok: true });
    expect(codeOf(await w.request(w.ava, { pageUrl: page, path }))).toBe('PAGE_OUTSIDE_PARTY_SITE');
  });

  it("refuses to move a client's site to other providers while a correction of it is open", async () => {
    const move = async () =>
      await w.world.db.app.withBusiness(w.world.business, async (tx) => {
        const site = await readPartySite(tx, w.partyB);
        return await bindPartySite(
          tx,
          { ...site!, defaultBranch: `release-${randomUUID().slice(0, 4)}` },
          w.admin.actorId,
        );
      });
    expect(await move()).toEqual({ ok: true });
    const asked = await w.request(w.dee, {
      partyId: w.partyB,
      taskId: w.taskB,
      pageUrl: B_PAGE,
      path: B_FILE,
    });
    expect(codeOf(asked)).toBe('not-a-refusal');
    expect(await move()).toEqual({ ok: false, code: 'SITE_UNDER_CORRECTION' });
  });

  it('makes a request wait for an unbind holding its page, then refuses it and stores nothing', async () => {
    const path = `src/pages/raced-${randomUUID().slice(0, 6)}.md`;
    const page = await bindExtra(path);
    const before = await storedIn(w.world.business);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let removed!: () => void;
    const deleted = new Promise<void>((resolve) => {
      removed = resolve;
    });
    // The unbind on a connection of its own, so the request's wait is on the page row.
    const second = connect(w.world.db.appUrl, { source: 'runtime' });
    try {
      const unbinding = second.withBusiness(w.world.business, async (tx) => {
        const answer = await unbindPartySitePage(tx, w.partyA, page);
        removed();
        await held;
        return answer;
      });
      await deleted;
      const request = w.request(w.ava, { pageUrl: page, path });
      await waitForALockWait(w);
      release();
      expect(await unbinding).toEqual({ ok: true });
      expect(codeOf(await request)).toBe('PAGE_OUTSIDE_PARTY_SITE');
      expect(await storedIn(w.world.business)).toBe(before);
    } finally {
      await second.close();
    }
  });
});

describe.skipIf(serverUrl === undefined)('an unbind and a request holding its page', () => {
  it('makes the unbind wait for the request, then refuses it', async () => {
    const path = `src/pages/held-${randomUUID().slice(0, 6)}.md`;
    const page = `https://agency.example/held-${randomUUID().slice(0, 6)}/`;
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      const site = await readPartySite(tx, w.partyA);
      await bindPartySite(
        tx,
        { ...site!, pages: [...site!.pages, { pageUrl: page, path }] },
        w.admin.actorId,
      );
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inserted!: () => void;
    const stored = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    // The request on a connection of its own, held open once its insert has locked the page.
    const second = connect(w.world.db.appUrl, { source: 'runtime' });
    try {
      const requesting = second.withBusiness(w.world.business, async (tx) => {
        const row = await insertLiveCorrection(tx, {
          partyId: w.partyA,
          taskId: w.taskA,
          requestedByActorId: w.ava.actorId,
          requestedByPersonId: w.ava.personId,
          delegationId: null,
          targetPath: path,
          word: 'friendly',
          replacement: 'welcoming',
          pageUrl: page,
          preImageDigest: 'pre-image',
          baseRevision: 'rev-1',
          seam: `seam-${randomUUID()}`,
          versionDigest: 'version',
        });
        inserted();
        await held;
        return row;
      });
      await stored;
      const unbinding = w.world.db.app.withBusiness(
        w.world.business,
        async (tx) => await unbindPartySitePage(tx, w.partyA, page),
      );
      await waitForALockWait(w);
      release();
      expect('id' in (await requesting)).toBe(true);
      expect(await unbinding).toEqual({ ok: false, code: 'PAGE_UNDER_CORRECTION' });
    } finally {
      await second.close();
    }
  });
});

/** Until some session of this database waits on a row lock (one side behind the other). */
async function waitForALockWait(world: C80World): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling for the waiter
    const [row] = await world.world.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`,
      [],
    );
    if (Number(row?.n) > 0) return;
    // oxlint-disable-next-line no-await-in-loop -- polling for the waiter
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('neither side waited on the other');
}
