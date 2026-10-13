// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 sidebar door: `live_correction.locate` finds the file behind a page the
// person names, from the snapshot the correction job keeps of each bound page,
// so the API holds no site credential. It answers only for a page the task's
// own client's site holds, byte for byte, and only to a caller who could
// request a correction there (`task:read` on the task, `run:write` at its
// client). Every other case is one `NOT_FOUND`, the same answer as a page that
// names nothing: another client's page, another business's, a page with no
// snapshot yet, another spelling, a caller whose grant is on another client.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c80World, BEFORE, type C80World } from './c80-world.ts';
import { ABOUT, ASTRO_PAGE, B_FILE, B_PAGE, PAGE } from './c80-sites.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { unbindPartySitePage } from '../../packages/core-records/src/site/party-sites.ts';
import type { Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C80 sidebar locate: DATABASE_URL is unset.');

const REVISION = 'a'.repeat(40);
const B_TEXT = '# Team\n\nOur friendly team.\n';
const BETA_TEXT = '# About beta\n\nNot the agency.\n';

let w: C80World;

const locate = async (
  member: Member,
  operands: Readonly<Record<string, unknown>>,
  business = w.world.business,
) =>
  await executeRead(w.world.db.app, business, member.presented, {
    read: 'live_correction.locate',
    ...operands,
  });

const snapshot = async (business: string, pageUrl: string, text: string) => {
  await w.world.db.admin.execute(
    `insert into public.party_site_page_snapshots (business_id, page_url, source_revision, source_text)
     values ($1, $2, $3, $4)`,
    [business, pageUrl, REVISION, text],
  );
};

/** The answer to a page no site holds: what every refused case must equal, byte for byte. */
const unseen = async (member: Member, taskId: string, business = w.world.business) =>
  JSON.stringify(
    await locate(
      member,
      { recordId: taskId, pageUrl: `https://nowhere.example/${randomUUID()}/` },
      business,
    ),
  );

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('c80locate');
  await snapshot(w.world.business, PAGE, BEFORE);
  await snapshot(w.world.business, B_PAGE, B_TEXT);
  await snapshot(w.beta, PAGE, BETA_TEXT);
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C80 sidebar locate', () => {
  it('answers the file behind a page of the task’s own client, as its snapshot holds it', async () => {
    expect(await locate(w.ava, { recordId: w.taskA, pageUrl: PAGE })).toStrictEqual({
      ok: true,
      target: {
        partyId: w.partyA,
        taskId: w.taskA,
        path: ABOUT,
        pageUrl: PAGE,
        baseRevision: REVISION,
        before: BEFORE,
      },
    });
  });

  it('answers a caller whose grant is on that client alone', async () => {
    const answer = await locate(w.dee, { recordId: w.taskB, pageUrl: B_PAGE });
    expect(answer).toMatchObject({ ok: true, target: { partyId: w.partyB, path: B_FILE } });
  });
});

describe.skipIf(serverUrl === undefined)('C80 sidebar locate, refused as nothing found', () => {
  it('answers another client’s page as a page that names nothing', async () => {
    const refused = JSON.stringify(await locate(w.ava, { recordId: w.taskA, pageUrl: B_PAGE }));
    expect(refused).toContain('NOT_FOUND');
    expect(refused).toBe(await unseen(w.ava, w.taskA));
  });

  it('answers a caller whose run grant is on another client as a page that names nothing', async () => {
    const refused = JSON.stringify(await locate(w.dee, { recordId: w.taskA, pageUrl: PAGE }));
    expect(refused).toContain('NOT_FOUND');
    expect(refused).toBe(await unseen(w.dee, w.taskA));
  });

  it('never answers another business’s snapshot of the same address', async () => {
    const refused = JSON.stringify(
      await locate(w.eve, { recordId: w.taskA, pageUrl: PAGE }, w.beta),
    );
    expect(refused).toContain('NOT_FOUND');
    expect(refused).toBe(await unseen(w.eve, w.taskA, w.beta));
    const own = await locate(w.eve, { recordId: w.betaTask, pageUrl: PAGE }, w.beta);
    expect(own).toMatchObject({ ok: true, target: { before: BETA_TEXT } });
  });

  it('answers a bound page with no snapshot yet as a page that names nothing', async () => {
    const refused = JSON.stringify(await locate(w.ava, { recordId: w.taskA, pageUrl: ASTRO_PAGE }));
    expect(refused).toContain('NOT_FOUND');
    expect(refused).toBe(await unseen(w.ava, w.taskA));
  });

  it('counts no other spelling of the page', async () => {
    const spellings = [PAGE.slice(0, -1), PAGE.toUpperCase(), PAGE.replace('about', 'ab%6Fut')];
    const refused = await Promise.all(
      spellings.map(async (pageUrl) =>
        JSON.stringify(await locate(w.ava, { recordId: w.taskA, pageUrl })),
      ),
    );
    const nothing = await unseen(w.ava, w.taskA);
    expect(refused).toStrictEqual(spellings.map(() => nothing));
  });
});

describe.skipIf(serverUrl === undefined)('C80 page snapshots', () => {
  it('keeps no snapshot over 256 KB', async () => {
    const page = `https://agency.example/large-${randomUUID()}/`;
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await tx.query(
        `insert into public.party_site_pages (business_id, party_id, page_url, path) values ($1, $2, $3, $4)`,
        [tx.businessId, w.partyA, page, ABOUT],
      );
    });
    await expect(snapshot(w.world.business, page, 'x'.repeat(262_145))).rejects.toThrow(
      /party_site_page_snapshots_text_size/u,
    );
  });

  it('lets the application read a snapshot and never write one', async () => {
    await expect(
      w.world.db.app.withBusiness(w.world.business, async (tx) => {
        await tx.query(
          `update public.party_site_page_snapshots set source_text = 'changed' where page_url = $1`,
          [PAGE],
        );
      }),
    ).rejects.toThrow(/permission denied/u);
  });

  it('drops a page’s snapshot when the page is unbound', async () => {
    const page = `https://agency.example/gone-${randomUUID()}/`;
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await tx.query(
        `insert into public.party_site_pages (business_id, party_id, page_url, path) values ($1, $2, $3, $4)`,
        [tx.businessId, w.partyA, page, ABOUT],
      );
    });
    await snapshot(w.world.business, page, BEFORE);
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      expect(await unbindPartySitePage(tx, w.partyA, page)).toMatchObject({ ok: true });
    });
    const left = await w.world.db.admin.execute(
      'select 1 from public.party_site_page_snapshots where business_id = $1 and page_url = $2',
      [w.world.business, page],
    );
    expect(left).toHaveLength(0);
  });
});
