// SPDX-License-Identifier: AGPL-3.0-only
//
// #1988: the side chat's context gives the model the business's own bound
// pages the caller's `run:write` reaches, each by repository and address, in
// the page field, and `conversation.read` serves the same list for a kept tab.
// Crossings, each through the chat's own context read: another business's own
// site, a client's site in the same business, a person whose grant is one
// client's, and a person with no run grant at all are each given none of it.
// The page's file path never leaves.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c80World, type C80World } from './c80-world.ts';
import { B_PAGE, PAGE } from './c80-sites.ts';
import { contextOf } from '../../packages/core-commands/src/commands/conversation-context.ts';
import type { Member } from '../commands/fixture.ts';
import { bindPartySite, withSession } from '../../packages/core-records/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('Bound pages in the chat: DATABASE_URL is unset, so nothing ran.');

const FILE = 'src/pages/secret-path-marker.md';

let w: C80World;
const own: Record<string, { repository: string; page: string }> = {};

/** Bind `business`'s own site (no party) with one page, as the operator's script does. */
async function bindOwn(
  business: string,
  by: Member,
): Promise<{ repository: string; page: string }> {
  const name = randomUUID().slice(0, 8);
  const site = { repository: `own/site-${name}`, page: `https://own-${name}.example/about` };
  const bound = await w.world.db.app.withBusiness(
    business,
    async (tx) =>
      await bindPartySite(
        tx,
        {
          partyId: null,
          repository: site.repository,
          defaultBranch: 'main',
          project: `prj_own_${name}`,
          pages: [{ pageUrl: site.page, path: FILE }],
        },
        by.actorId,
      ),
  );
  expect(bound).toEqual({ ok: true });
  return site;
}

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('chatpages');
  own['alpha'] = await bindOwn(w.world.business, w.admin);
  own['beta'] = await bindOwn(w.beta, w.eve);
});

/** The chat context `member` is given in `business`, on no task: its fields, and the sites it carries. */
async function contextFor(business: string, member: Member) {
  const context = await withSession(
    w.world.db.app,
    business,
    member.presented,
    async (tx, session) =>
      await contextOf(
        tx,
        session,
        { conversationId: randomUUID(), messageId: randomUUID(), body: 'Fix the About page' },
        null,
      ),
  );
  if (!('fields' in context)) throw new Error('the session was refused');
  return context;
}

describe.skipIf(serverUrl === undefined)('the bound pages the chat is given', () => {
  it('gives a business-wide run:write holder their own business’s pages, in the page field, and no path', async () => {
    const context = await contextFor(w.world.business, w.ava);
    expect(context.sites).toEqual([own['alpha']]);
    const page = context.fields.find((field) => field.name === 'page');
    expect(JSON.parse(page?.value ?? '{}')).toStrictEqual({ sites: [own['alpha']] });
    expect(JSON.stringify(context)).not.toContain(FILE);
  });

  it('never gives a client’s site in the same business, nor another business’s own site', async () => {
    const pages = (await contextFor(w.world.business, w.ava)).sites.map((site) => site.page);
    expect(pages).not.toContain(PAGE);
    expect(pages).not.toContain(B_PAGE);
    expect(pages).not.toContain(own['beta']?.page);
    const theirs = await contextFor(w.beta, w.eve);
    expect(theirs.sites).toEqual([own['beta']]);
    expect(JSON.stringify(theirs)).not.toContain(own['alpha']?.page ?? 'unset');
  });

  it('gives none to a person whose run grant is one client’s, or who holds no run grant', async () => {
    for (const member of [w.dee, w.admin]) {
      // eslint-disable-next-line no-await-in-loop -- one person at a time
      const context = await contextFor(w.world.business, member);
      expect(context.sites).toEqual([]);
      expect(context.fields.find((field) => field.name === 'page')).toBeUndefined();
      expect(JSON.stringify(context)).not.toContain(own['alpha']?.page ?? 'unset');
    }
  });
});
