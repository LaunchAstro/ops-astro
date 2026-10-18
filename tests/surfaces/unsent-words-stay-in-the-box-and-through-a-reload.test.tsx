// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A failed chat send's words, held where the person left them: in the box
// after a send with no answer, in the tab after page and dock sends both fail,
// and through a reload after Edit took refused words back into the box. The
// stored words stay with the sign-in that wrote them. Copied from the
// reviewer's proofs on #1892.
import { act } from 'react';
import { expect, it } from 'vitest';
import { TeamScreen } from '../../apps/web/src/screens/Team.tsx';
import { ChatOutbox } from '../../apps/web/src/screens/team/outbox.ts';
import type { StorageLike } from '../../apps/web/src/session/storage-slot.ts';
import { mount, type Mounted } from './mount.tsx';
import { server } from './team-chat-stand-in.ts';

const OWNER = 'alpha:ana@example.test:0';
const WORDS = 'recovery canary';
function storage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => {
      values.set(k, v);
    },
    removeItem: (k) => {
      values.delete(k);
    },
  };
}
async function until(check: () => boolean, tries = 100): Promise<void> {
  if (check()) return;
  if (tries === 0) throw new Error('condition never reached');
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  });
  await until(check, tries - 1);
}
async function screen(api: ReturnType<typeof server>, kept: StorageLike) {
  const m = await mount(<TeamScreen client={api.client} grantKey={OWNER} storage={kept} />);
  await until(() => m.all('.tmc__conv .msg').length > 0);
  return m;
}
async function send(m: Mounted, words: string) {
  await m.type('.composer input', words);
  await act(() => {
    m.find('form.composer')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  });
  await until(() => m.find('[role="alert"]') !== null);
}

it('a send with no answer keeps its words in the box and offers Resend', async () => {
  const api = server();
  api.state.unanswered = 'before';
  const m = await screen(api, storage());
  await send(m, WORDS);
  expect(m.find('[data-unsent-resend]')).not.toBeNull();
  expect((m.find('.composer input') as HTMLInputElement).value).toBe(WORDS);
});

it('failed sends from the page and the dock both survive a reload', async () => {
  const kept = storage();
  const api = server();
  api.state.unanswered = 'before';
  const page = await screen(api, kept);
  const dock = await screen(api, kept);
  await send(page, 'page recovery words');
  await send(dock, 'dock recovery words');
  await page.unmount();
  await dock.unmount();
  const again = await screen(server(), kept);
  const words = again.all('[data-unsent-words]').map((el) => el.textContent);
  expect(words).toEqual(expect.arrayContaining(['page recovery words', 'dock recovery words']));
});

it('refused words taken back into the box by Edit survive a reload', async () => {
  const kept = storage();
  const api = server();
  api.state.refuse = { refused: true, code: 'FIELD_VALUE_INVALID', names: ['body'], fixes: [] };
  const m = await screen(api, kept);
  await send(m, WORDS);
  await m.click('[data-unsent-edit]');
  expect((m.find('.composer input') as HTMLInputElement).value).toBe(WORDS);
  await m.unmount();
  const again = await screen(server(), kept);
  expect(again.text() + (again.find('.composer input') as HTMLInputElement).value).toContain(WORDS);
});

it('stored words are never read by another business, person or session', () => {
  const kept = storage();
  const original = new ChatOutbox(OWNER, kept);
  const leave = original.mount();
  original.sending({
    id: '00000000-0000-4000-8000-000000000001',
    to: 'p-bo',
    kind: 'direct',
    body: WORDS,
    state: 'sending',
  });
  leave();
  expect(new ChatOutbox('bravo:ana@example.test:0', kept).snapshot()).toEqual([]);
  expect(new ChatOutbox('alpha:bea@example.test:0', kept).snapshot()).toEqual([]);
  expect(new ChatOutbox('alpha:ana@example.test:1', kept).snapshot()).toEqual([]);
});

it('a Resend refused after no answer gives its words back to the list, Edit and all, once the box is emptied', async () => {
  const api = server();
  api.state.unanswered = 'before';
  const m = await screen(api, storage());
  await send(m, WORDS);
  api.state.unanswered = null;
  api.state.refuse = { refused: true, code: 'FIELD_VALUE_INVALID', names: ['body'], fixes: [] };
  await m.click('[data-unsent-resend]');
  await until(() => api.sent.length === 2 && m.find('[role="alert"]') !== null);
  await m.type('.composer input', '');
  expect(m.all('[data-unsent-words]').map((el) => el.textContent)).toContain(WORDS);
  expect(m.find('[data-unsent-edit]')).not.toBeNull();
});
