// SPDX-License-Identifier: AGPL-3.0-only
//
// While a correction of a client is open (requested up to live), no page of
// that client's site is unbound and its providers do not move: a decision, a
// publish and a revert all act on the site the request named. An unbind and a
// request on one page are held in either order, each on its own connection,
// with the waiting side seen in pg_stat_activity: the unbind first leaves the
// request refused with nothing stored; the request first leaves the unbind
// refused.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c80World, type C80World } from './c80-world.ts';
import { B_FILE, B_PAGE } from './c80-sites.ts';
import { connect, insertLiveCorrection } from '../../packages/core-records/src/index.ts';
import {
  bindPartySite,
  readPartySite,
  unbindPartySitePage,
} from '../../packages/core-records/src/site/party-sites.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('Frozen site: DATABASE_URL is unset, so nothing ran.');

let w: C80World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('frozensite');
  await w.setApprover(w.ben.personId);
});

/** A fresh page and file bound on party A's site. */
async function freshPage(): Promise<{ readonly pageUrl: string; readonly path: string }> {
  const name = randomUUID().slice(0, 8);
  const added = { pageUrl: `https://agency.example/${name}/`, path: `src/pages/${name}.md` };
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    const site = await readPartySite(tx, w.partyA);
    if (site === undefined) throw new Error('party A has no site');
    await bindPartySite(tx, { ...site, pages: [...site.pages, added] }, w.admin.actorId);
  });
  return added;
}

const unbind = async (pageUrl: string) =>
  await w.world.db.app.withBusiness(
    w.world.business,
    async (tx) => await unbindPartySitePage(tx, w.partyA, pageUrl),
  );

/** Ava's request on party A's task for `pageUrl` and `path`, as the record layer stores one. */
const askedOn = (pageUrl: string, path: string) => ({
  partyId: w.partyA,
  taskId: w.taskA,
  requestedByActorId: w.ava.actorId,
  requestedByPersonId: w.ava.personId,
  delegationId: null,
  targetPath: path,
  word: 'friendly',
  replacement: 'welcoming',
  pageUrl,
  preImageDigest: 'pre-image',
  baseRevision: 'rev-1',
  seam: `seam-${randomUUID()}`,
  versionDigest: 'version',
});

/** A latch: `open` lets every `passed` through. */
function latch(): { readonly open: () => void; readonly passed: Promise<void> } {
  let open!: () => void;
  const passed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, passed };
}

/** Until some session of this database waits on a row lock (one side behind the other). */
async function aLockWait(): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling for the waiter
    const [row] = await w.world.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`,
      [],
    );
    if (Number(row?.n) > 0) return;
    // oxlint-disable-next-line no-await-in-loop -- polling for the waiter
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error('neither side waited on the other');
}

describe.skipIf(serverUrl === undefined)('unbinding a page', () => {
  it('refuses to unbind a page under a requested or approved correction', async () => {
    const { pageUrl, path } = await freshPage();
    const asked = detailOf(await w.request(w.ava, { pageUrl, path }));
    expect(await unbind(pageUrl)).toEqual({ ok: false, code: 'PAGE_UNDER_CORRECTION' });
    const id = String(asked['correctionId']);
    expect(codeOf(await w.approve(w.ben, id, String(asked['versionId'])))).toBe('not-a-refusal');
    expect(await unbind(pageUrl)).toEqual({ ok: false, code: 'PAGE_UNDER_CORRECTION' });
  });

  it('unbinds a page once its correction is rejected, and refuses the next request', async () => {
    const { pageUrl, path } = await freshPage();
    const asked = detailOf(await w.request(w.ava, { pageUrl, path }));
    const rejected = await w.as(w.ben, {
      command: 'live_correction.decide',
      correctionId: asked['correctionId'],
      versionId: asked['versionId'],
      decision: 'reject',
    });
    expect(codeOf(rejected)).toBe('not-a-refusal');
    expect(await unbind(pageUrl)).toEqual({ ok: true });
    expect(codeOf(await w.request(w.ava, { pageUrl, path }))).toBe('PAGE_OUTSIDE_PARTY_SITE');
  });
});

describe.skipIf(serverUrl === undefined)("moving a client's site", () => {
  it('refuses other providers while a correction of the site is open', async () => {
    const move = async () =>
      await w.world.db.app.withBusiness(w.world.business, async (tx) => {
        const site = await readPartySite(tx, w.partyB);
        if (site === undefined) throw new Error('party B has no site');
        const defaultBranch = `release-${randomUUID().slice(0, 4)}`;
        return await bindPartySite(tx, { ...site, defaultBranch }, w.admin.actorId);
      });
    expect(await move()).toEqual({ ok: true });
    const onB = { partyId: w.partyB, taskId: w.taskB, pageUrl: B_PAGE, path: B_FILE };
    expect(codeOf(await w.request(w.dee, onB))).toBe('not-a-refusal');
    expect(await move()).toEqual({ ok: false, code: 'SITE_UNDER_CORRECTION' });
  });
});

describe.skipIf(serverUrl === undefined)('an unbind holding the page a request names', () => {
  it('makes the request wait, then refuses it and stores nothing', async () => {
    const { pageUrl, path } = await freshPage();
    const [deleted, release] = [latch(), latch()];
    const second = connect(w.world.db.appUrl, { source: 'runtime' });
    try {
      const unbinding = second.withBusiness(w.world.business, async (tx) => {
        const answer = await unbindPartySitePage(tx, w.partyA, pageUrl);
        deleted.open();
        await release.passed;
        return answer;
      });
      await deleted.passed;
      const request = w.request(w.ava, { pageUrl, path });
      await aLockWait();
      release.open();
      expect(await unbinding).toEqual({ ok: true });
      expect(codeOf(await request)).toBe('PAGE_OUTSIDE_PARTY_SITE');
    } finally {
      await second.close();
    }
  });
});

describe.skipIf(serverUrl === undefined)('a request holding the page an unbind names', () => {
  it('makes the unbind wait, then refuses it', async () => {
    const { pageUrl, path } = await freshPage();
    const [inserted, release] = [latch(), latch()];
    const second = connect(w.world.db.appUrl, { source: 'runtime' });
    try {
      const requesting = second.withBusiness(w.world.business, async (tx) => {
        const row = await insertLiveCorrection(tx, askedOn(pageUrl, path));
        inserted.open();
        await release.passed;
        return row;
      });
      await inserted.passed;
      const unbinding = unbind(pageUrl);
      await aLockWait();
      release.open();
      expect('id' in (await requesting)).toBe(true);
      expect(await unbinding).toEqual({ ok: false, code: 'PAGE_UNDER_CORRECTION' });
    } finally {
      await second.close();
    }
  });
});
