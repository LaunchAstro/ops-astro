// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11, the assistant panel's conversation tabs on the server: the list of
// the person's own conversations the tab row draws (CS-7.32, switch), a new
// tab (CS-7.34, the first message mints it, AW-03), rename (CS-7.32), and
// "Add page to context" (CS-7.31): the current page, its address and what it
// shows, as the conversation's scope, a second pointer replacing the first.
// Through the real API over a fresh database, and the shipped command line.
//
// The ticket marks these actions "not audited". Every attempt writes one
// audit event (minimum contract 4.2), so the claim tested is the one SL12
// already ruled for MP-6-2: no event beyond the command's own one, carrying
// the payload's digest and never the text.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, type Member } from '../commands/fixture.ts';
import type { Answer } from './fixture.ts';
import { conversationWorld, detail, started, type ConversationWorld } from './aw-03-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Tab {
  readonly id: string;
  readonly address: string;
  readonly title: string;
  readonly lastActivityAt: string;
  readonly bodyPurged: boolean;
}

const tabsOf = (answer: Answer): readonly Tab[] => {
  expect(answer.status).toBe(200);
  return (answer.body as { readonly conversations: readonly Tab[] }).conversations;
};

const conversationOf = (answer: Answer): Record<string, unknown> => {
  expect(answer.status).toBe(200);
  return (answer.body as { readonly conversation: Record<string, unknown> }).conversation;
};

// eslint-disable-next-line max-lines-per-function -- one world, every tab action on it
describe.skipIf(serverUrl === undefined)('MP-7-11 conversation tabs', () => {
  let w: ConversationWorld;
  let stranger: Member;

  const read = async (member: Member, conversationId: string): Promise<Answer> =>
    await w.as(member, 'conversation.read', { conversationId });
  const audited = async (command: string): Promise<number> =>
    await w.count(`select count(*) as n from public.audit_events where command = $1`, [command]);

  beforeAll(async () => {
    w = await conversationWorld('mp_7_11_tabs');
    stranger = await enrol(w.fixture.db.app, w.fixture.business, 'no-conversation-grant');
  }, 180_000);

  afterAll(async () => await w?.drop());

  it('MP-7-11 fresh tab: a new conversation is minted by its first message and joins the tab row', async () => {
    const before = tabsOf(await w.as(w.owner, 'conversation.list', {}));
    const id = await started(w, w.owner, { body: 'what is on this page?' });
    const after = tabsOf(await w.as(w.owner, 'conversation.list', {}));
    expect(after.length).toBe(before.length + 1);
    expect(after[0]).toMatchObject({ id, address: `/agent/${id}`, bodyPurged: false });
  });

  it('MP-7-11 switch conversations: the list is the person’s own, newest activity first, and each opens', async () => {
    const older = await started(w, w.owner, { body: 'first', title: 'Older' });
    const newer = await started(w, w.owner, { body: 'second', title: 'Newer' });
    await w.as(w.owner, 'conversation.message', { conversationId: older, body: 'again' });
    const tabs = tabsOf(await w.as(w.owner, 'conversation.list', {}));
    const order = tabs.map((tab) => tab.id);
    expect(order.indexOf(older)).toBeLessThan(order.indexOf(newer));
    for (const tab of tabs) {
      // eslint-disable-next-line no-await-in-loop -- each tab opens in turn
      expect(conversationOf(await read(w.owner, tab.id))['id']).toBe(tab.id);
    }
    const theirs = await started(w, w.colleague, { body: 'the colleague’s own', title: 'Theirs' });
    expect(tabsOf(await w.as(w.owner, 'conversation.list', {})).map((tab) => tab.id)).not.toContain(
      theirs,
    );
    expect(tabsOf(await w.as(w.colleague, 'conversation.list', {})).map((tab) => tab.id)).toEqual([
      theirs,
    ]);
  });

  it('MP-7-11 conversation tabs: rename changes the tab’s title and nothing else, through the API and the command line', async () => {
    const id = await started(w, w.owner, { body: 'rename me', title: 'Before' });
    const renamed = detail(
      await w.as(w.owner, 'conversation.rename', { conversationId: id, title: 'After' }),
    );
    // The answer names the conversation and its address; the register stores
    // the answer, so the title is kept on the conversation and nowhere else.
    expect(renamed).toEqual({ conversationId: id, address: `/agent/${id}` });
    const shown = conversationOf(await read(w.owner, id));
    expect(shown['title']).toBe('After');
    const cli = await w.cli(w.owner, 'conversation.rename', { conversationId: id, title: 'Again' });
    expect(cli.status).toBe(200);
    expect(conversationOf(await read(w.owner, id))['title']).toBe('Again');
    // A rename is not activity: the wrap-up at quiet and the purge window
    // measure the exchange, not the tab's label.
    expect(conversationOf(await read(w.owner, id))['lastActivityAt']).toBe(shown['lastActivityAt']);
    for (const title of ['', '   ', 'x'.repeat(121), 7, null]) {
      // eslint-disable-next-line no-await-in-loop -- one refusal at a time
      const bad = await w.as(w.owner, 'conversation.rename', { conversationId: id, title });
      expect(bad.status).toBe(422);
      expect(bad.body['code']).toBe('FIELD_VALUE_INVALID');
    }
  });

  it('MP-7-11 add page to context: the current page becomes the conversation’s scope, its address and what it shows', async () => {
    const id = await started(w, w.owner, { body: 'about this page' });
    expect(conversationOf(await read(w.owner, id))['page']).toBeNull();
    const page = { address: '/settings/general', shows: 'Settings: General' };
    const set = detail(await w.as(w.owner, 'conversation.set_scope', { conversationId: id, page }));
    expect(set).toEqual({ conversationId: id, address: `/agent/${id}` });
    expect(conversationOf(await read(w.owner, id))['page']).toEqual(page);
  });

  it('MP-7-11 page scope replaces: a second pointer replaces the first, nothing accumulates, and null clears it', async () => {
    const id = await started(w, w.owner, { body: 'pointer twice' });
    const first = { address: '/tasks/board', shows: 'Tasks board' };
    const second = { address: '/settings/general', shows: 'Settings: General' };
    await w.as(w.owner, 'conversation.set_scope', { conversationId: id, page: first });
    await w.as(w.owner, 'conversation.set_scope', { conversationId: id, page: second });
    const shown = JSON.stringify(conversationOf(await read(w.owner, id)));
    expect(shown).toContain(second.address);
    expect(shown).not.toContain(first.address);
    expect(shown).not.toContain(first.shows);
    await w.as(w.owner, 'conversation.set_scope', { conversationId: id, page: null });
    expect(conversationOf(await read(w.owner, id))['page']).toBeNull();
  });

  it('MP-7-11 add page to context: an address that is not a page of this product is refused by name, whatever its spelling', async () => {
    const id = await started(w, w.owner, { body: 'hostile pointers' });
    const hostile = [
      'https://elsewhere.example/settings',
      '//elsewhere.example/settings',
      '/\\elsewhere.example',
      'javascript:alert(1)',
      ' /settings',
      '/settings\n/other',
      '/settings\t',
      '/settings\u0000',
      'settings',
      `/${'a'.repeat(400)}`,
      '',
    ];
    for (const address of hostile) {
      // eslint-disable-next-line no-await-in-loop -- one refusal at a time
      const bad = await w.as(w.owner, 'conversation.set_scope', {
        conversationId: id,
        page: { address, shows: 'A page' },
      });
      expect(bad.status, address).toBe(422);
      expect(bad.body['code']).toBe('FIELD_VALUE_INVALID');
    }
    for (const page of [
      { address: '/settings' },
      { address: '/settings', shows: '' },
      { address: '/settings', shows: 'x'.repeat(201) },
      { address: '/settings', shows: 'Settings', record: randomUUID() },
      '/settings',
      [],
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one refusal at a time
      const bad = await w.as(w.owner, 'conversation.set_scope', { conversationId: id, page });
      expect(bad.status, JSON.stringify(page)).toBe(422);
    }
    expect(conversationOf(await read(w.owner, id))['page']).toBeNull();
  });

  it('MP-7-11 add page to context: the database refuses a page outside the product even when the command is gone round', async () => {
    const id = await started(w, w.owner, { body: 'backstop' });
    for (const [address, shows] of [
      ['//elsewhere.example', 'A page'],
      ['/\\elsewhere.example', 'A page'],
      ['https://elsewhere.example', 'A page'],
      ['/settings\\x', 'A page'],
      ['/settings page', 'A page'],
      [`/${'a'.repeat(300)}`, 'A page'],
      ['/settings', 'two\nlines'],
      ['/settings', null],
      [null, 'Settings'],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one refusal at a time
      await expect(
        w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
          await tx.query(
            `update conversations set page_address = $3, page_shows = $4
              where business_id = $1 and id = $2`,
            [tx.businessId, id, address, shows],
          );
        }),
        String(address),
      ).rejects.toThrow(/conversations_page_/u);
    }
    expect(conversationOf(await read(w.owner, id))['page']).toBeNull();
  });

  it('MP-7-11 owner-only conversations: only the owner renames or sets the scope; another person is refused and nothing changes', async () => {
    const title = `Mine-${randomUUID()}`;
    const id = await started(w, w.owner, { body: 'only mine', title });
    for (const [name, body] of [
      ['conversation.rename', { conversationId: id, title: 'Taken' }],
      ['conversation.set_scope', { conversationId: id, page: { address: '/x', shows: 'X' } }],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one refusal at a time
      const colleague = await w.as(w.colleague, name, body);
      expect(colleague.status).toBe(403);
      expect(colleague.body['code']).toBe('SCOPE_NOT_GRANTED');
      expect(JSON.stringify(colleague.body)).not.toContain(title);
    }
    const shown = conversationOf(await read(w.owner, id));
    expect(shown).toMatchObject({ title, page: null });
    const madeUp = await w.as(w.owner, 'conversation.rename', {
      conversationId: randomUUID(),
      title: 'Nobody’s',
    });
    expect(madeUp.status).toBe(404);
  });

  it('MP-7-11 refusal conversation:write: a person without conversation:write lists, renames and scopes nothing', async () => {
    const id = await started(w, w.owner, { body: 'not theirs' });
    for (const [name, body] of [
      ['conversation.list', {}],
      ['conversation.rename', { conversationId: id, title: 'No' }],
      ['conversation.set_scope', { conversationId: id, page: null }],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one refusal at a time
      const refused = await w.as(stranger, name, body);
      expect(refused.status, name).toBe(403);
      expect(refused.body['code']).toBe('SCOPE_NOT_GRANTED');
      expect(JSON.stringify(refused.body)).not.toContain(id);
    }
  });

  it('MP-7-11 no audit beyond the command’s own: each rename, scope and list writes exactly its one event, with the digest and never the text, in the register neither', async () => {
    const id = await started(w, w.owner, { body: 'counting events' });
    const planted = `Planted-${randomUUID()}`;
    const counts = async (): Promise<readonly number[]> => [
      await audited('conversation.rename'),
      await audited('conversation.set_scope'),
      await audited('conversation.list'),
      await w.count(`select count(*) as n from public.audit_events`, []),
    ];
    const [rename, scope, list, all] = await counts();
    await w.as(w.owner, 'conversation.rename', { conversationId: id, title: planted });
    await w.as(w.owner, 'conversation.set_scope', {
      conversationId: id,
      page: { address: '/settings', shows: planted },
    });
    await w.as(w.owner, 'conversation.list', {});
    expect(await counts()).toEqual([
      (rename ?? 0) + 1,
      (scope ?? 0) + 1,
      (list ?? 0) + 1,
      (all ?? 0) + 3,
    ]);
    const rows = await w.fixture.db.admin.execute<{ readonly row: string }>(
      `select row_to_json(a)::text as row from public.audit_events a
       union all select row_to_json(r)::text from public.operations r`,
      [],
    );
    for (const row of rows) expect(row.row).not.toContain(planted);
  });
});
