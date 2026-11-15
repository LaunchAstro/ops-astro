// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Docs piece 4b (#2515), Sol's round 1 on #2527: what a person typed is never lost to a refresh
// or a late answer. A routine re-read keeps the editor's draft, a refused one included
// (S2527-1); words typed while a save was in flight stay, and the next save starts from the
// version that save made (S2527-2); a cancelled form's late success closes nothing opened since
// (S2527-3), nor closes a draft reopened since, even one with the same words (S2527-4); and an
// answer for an owner the screen has left draws nothing (the owner guard).

import { afterEach, expect, it, vi } from 'vitest';
import { useState, type ReactElement } from 'react';
import { open, json, settle } from './mp-2-1-support.tsx';
import { mount } from '../surfaces/mount.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { useDocsWrite, type DocsAnswer } from '../../apps/web/src/screens/docs/docs-write.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const TREE = {
  ok: true,
  folders: [{ id: 'f-top', name: 'Handbook', parentId: null }],
  pages: [{ id: 'p-one', folderId: 'f-top', title: 'First week', version: 2 }],
};

const PAGE = {
  ok: true,
  document: {
    id: 'p-one',
    folderId: 'f-top',
    title: 'First week',
    body: '# Welcome',
    version: 2,
    updatedAt: '2026-11-15T00:00:00.000Z',
  },
};

type Sent = { readonly name: string; readonly body: Record<string, unknown> };

/** While set, a page read waits for it, so a re-read is seen loading as a real one is. */
let pageGate: Promise<null> | null = null;

/** A value a test releases when it chooses. */
class Held<T> {
  release: (value: T) => void = () => {};
  readonly answer: Promise<T> = new Promise<T>((resolve) => {
    this.release = resolve;
  });
}
const held = (): Held<Response> => new Held<Response>();

/** Reads answered at once; each write by `writes`, else applied. */
function docsFetch(
  sent: Sent[],
  writes: Readonly<Record<string, (body: Record<string, unknown>) => Promise<Response>>> = {},
) {
  return async (input: unknown, init?: RequestInit) => {
    const path = String(input instanceof Request ? input.url : input);
    const match = /\/([a-z_]+)\/([a-z_]+)$/u.exec(path);
    const name = match === null ? path : `${match[1]}.${match[2]}`;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    sent.push({ name, body });
    if (name === 'session.capabilities') {
      return json({
        ok: true,
        personId: 'person-mia',
        businessKey: 'alpha',
        grants: [
          { collection: 'docs', action: 'read' },
          { collection: 'docs', action: 'write' },
        ],
      });
    }
    if (name === 'docs.tree') return json(TREE);
    if (name === 'docs.page') {
      if (pageGate !== null) await pageGate;
      return json(PAGE);
    }
    const write = writes[name];
    if (write !== undefined) return await write(body);
    return json({ ok: true, detail: { folderId: 'f-new', version: 3 } });
  };
}

const writesOf = (sent: readonly Sent[], name: string) => sent.filter((one) => one.name === name);
const draftOf = (page: Awaited<ReturnType<typeof open>>) =>
  (page.view.find('textarea[data-docs-draft]') as HTMLTextAreaElement | null)?.value;

async function editing(sent: Sent[], writes = {}) {
  const page = await open('/docs/', { fetch: docsFetch(sent, writes) });
  await settle();
  await page.view.click('[data-page-id="p-one"]');
  await settle();
  await page.view.click('[data-docs-act="edit"]');
  return page;
}

/** A routine re-read: the tab coming back online, its page read answered only after it drew loading. */
async function refresh(): Promise<void> {
  const gate = new Held<null>();
  pageGate = gate.answer;
  window.dispatchEvent(new Event('online'));
  await settle();
  pageGate = null;
  gate.release(null);
  await settle();
  await settle();
}

/** The server's answer to a save against a version the page has moved past. */
const stale = () =>
  Promise.resolve(
    json({ refused: true, code: 'VERSION_STALE', names: ['expectedVersion'], fixes: [] }, 409),
  );

it('a routine re-read keeps the draft, a refused one included', async () => {
  const sent: Sent[] = [];
  const page = await editing(sent, { 'docs.update_page': stale });
  await page.view.type('textarea[data-docs-draft]', 'unsaved words');
  const reads = writesOf(sent, 'docs.page').length;
  await refresh();
  expect(writesOf(sent, 'docs.page').length).toBeGreaterThan(reads);
  expect(draftOf(page)).toBe('unsaved words');
  await page.view.click('[data-docs-act="save"]');
  await settle();
  expect(page.view.text()).toContain('This page changed since you opened it');
  await refresh();
  expect(draftOf(page)).toBe('unsaved words');
  expect(page.view.text()).toContain('This page changed since you opened it');
  // The save still names the version the page was opened at, never one a re-read brought.
  await page.view.click('[data-docs-act="save"]');
  await settle();
  expect(writesOf(sent, 'docs.update_page').map((s) => s.body['expectedVersion'])).toEqual([2, 2]);
});

it('words typed while a save was in flight stay, and the next save starts from its version', async () => {
  const sent: Sent[] = [];
  const first = held();
  let saves = 0;
  const save = () => {
    saves += 1;
    return saves === 1 ? first.answer : Promise.resolve(json({ ok: true, detail: { version: 4 } }));
  };
  const page = await editing(sent, { 'docs.update_page': save });
  await page.view.type('textarea[data-docs-draft]', 'first draft');
  await page.view.click('[data-docs-act="save"]');
  await page.view.type('textarea[data-docs-draft]', 'first draft and later words');
  first.release(json({ ok: true, detail: { pageId: 'p-one', version: 3 } }));
  await settle();
  await settle();
  expect(draftOf(page)).toBe('first draft and later words');
  await page.view.click('[data-docs-act="save"]');
  await settle();
  const bodies = writesOf(sent, 'docs.update_page').map((s) => s.body);
  expect(bodies[1]).toMatchObject({ expectedVersion: 3, body: 'first draft and later words' });
  expect(page.view.find('textarea[data-docs-draft]')).toBeNull();
});

it('a late save answer closes nothing reopened since, even with the same words', async () => {
  const sent: Sent[] = [];
  const first = held();
  let saves = 0;
  const save = () => {
    saves += 1;
    return saves === 1 ? first.answer : Promise.resolve(json({ ok: true, detail: { version: 4 } }));
  };
  const page = await editing(sent, { 'docs.update_page': save });
  await page.view.type('textarea[data-docs-draft]', 'restore these words');
  await page.view.click('[data-docs-act="save"]');
  await page.view.click('[data-docs-act="cancel"]');
  await page.view.click('[data-docs-act="edit"]');
  await page.view.type('textarea[data-docs-draft]', 'restore these words');
  first.release(json({ ok: true, detail: { pageId: 'p-one', version: 3 } }));
  await settle();
  await settle();
  // The reopened draft is its own: the old save's answer neither closes it nor moves its version.
  expect(draftOf(page)).toBe('restore these words');
  await page.view.click('[data-docs-act="save"]');
  await settle();
  expect(writesOf(sent, 'docs.update_page').map((s) => s.body['expectedVersion'])).toEqual([2, 2]);
});

it('a cancelled form’s late success closes nothing opened since', async () => {
  const sent: Sent[] = [];
  const first = held();
  let made = 0;
  const create = () => {
    made += 1;
    return made === 1 ? first.answer : Promise.resolve(json({ ok: true, detail: {} }));
  };
  const page = await open('/docs/', { fetch: docsFetch(sent, { 'docs.create_folder': create }) });
  await settle();
  await page.view.click('[data-docs-act="new-folder"]');
  await page.view.type('[data-docs-field="name"]', 'Old idea');
  await page.view.click('[data-docs-act="send"]');
  await page.view.click('[data-docs-act="cancel"]');
  await page.view.click('[data-docs-act="new-folder"]');
  await page.view.type('[data-docs-field="name"]', 'replacement folder draft');
  first.release(json({ ok: true, detail: { folderId: 'f-old' } }));
  await settle();
  await settle();
  expect((page.view.find('[data-docs-field="name"]') as HTMLInputElement | null)?.value).toBe(
    'replacement folder draft',
  );
  // The tree was still read again for the folder that was filed.
  expect(writesOf(sent, 'docs.tree').length).toBeGreaterThan(1);
});

/** The write hook alone, sent once, drawing what its answer came to. */
function Sender(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
}): ReactElement {
  const send = useDocsWrite(props.client, props.grantKey);
  const [answer, setAnswer] = useState<DocsAnswer | null>(null);
  return (
    <button
      type="button"
      data-answer={answer?.kind ?? 'none'}
      onClick={() => {
        void send('new-folder', 'docs.create_folder', { name: 'x' }).then(setAnswer);
      }}
    >
      send
    </button>
  );
}

it('an answer for an owner the screen has left draws nothing', async () => {
  const pending = held();
  const fetch = (async (input: unknown) => {
    const path = String(input instanceof Request ? input.url : input);
    return path.endsWith('/create_folder') ? await pending.answer : json({ ok: true });
  }) as unknown as typeof globalThis.fetch;
  const client = (businessKey: string) =>
    new OperationsClient({ origin: '', businessKey, signedIn: true, fetch });
  const view = await mount(<Sender client={client('alpha')} grantKey="alpha:mia" />);
  await view.click('button');
  // Same hook, another business and person: the answer for alpha arrives after.
  await view.render(<Sender client={client('bravo')} grantKey="bravo:ben" />);
  pending.release(json({ ok: true, detail: { folderId: 'f-alpha' } }));
  await settle();
  await settle();
  expect((view.find('button') as HTMLButtonElement | null)?.dataset['answer']).toBe('left');
  await view.unmount();
});
