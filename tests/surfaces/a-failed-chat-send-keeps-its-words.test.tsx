// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// #1339: a chat send the server refuses or never answers keeps the person's
// words. They wait under the conversation, never as a transcript message,
// until the server takes them or the person lets them go; a send with no
// answer also puts them back in the box. A resend after a lost answer reuses
// the first operation id, so the
// server posts the message once; the words survive a reload of the tab and
// stay with the sign-in that wrote them. The stand-in server is
// `team-chat-stand-in.ts`; the database half is
// `tests/api/a-direct-message-resent-under-its-first-operation-id-posts-once.test.ts`.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { TeamScreen } from '../../apps/web/src/screens/Team.tsx';
import { ChatOutbox } from '../../apps/web/src/screens/team/outbox.ts';
import type { StorageLike } from '../../apps/web/src/session/storage-slot.ts';
import { mount, type Mounted } from './mount.tsx';
import { GROUP, server } from './team-chat-stand-in.ts';

const CANARY = 'unsent message canary';

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  });
};

async function until(say: string, check: () => boolean, deadline = Date.now() + 2000) {
  if (check()) return;
  if (Date.now() > deadline) throw new Error(`never happened: ${say}`);
  await settle();
  await until(say, check, deadline);
}

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

function memoryStorage(): StorageLike {
  const kept = new Map<string, string>();
  return {
    getItem: (key) => kept.get(key) ?? null,
    setItem: (key, value) => {
      kept.set(key, value);
    },
    removeItem: (key) => {
      kept.delete(key);
    },
  };
}

async function team(
  api = server(),
  storage: StorageLike | null = null,
  grantKey = 'alpha:ana@example.test:0',
) {
  view = await mount(<TeamScreen client={api.client} grantKey={grantKey} storage={storage} />);
  const m = view;
  await until('the conversation open on Bo', () => m.all('.tmc__conv .msg').length > 0);
  return { api, m };
}

async function sendWords(m: Mounted, words: string): Promise<void> {
  await m.type('.tmc__conv .composer input', words);
  await act(() => {
    m.host
      .querySelector('.tmc__conv form.composer')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

const composer = (m: Mounted): string =>
  (m.find('.tmc__conv .composer input') as HTMLInputElement | null)?.value ?? '';
const unsent = (m: Mounted): string[] =>
  m.all('.tmc__conv .tmc__unsent [data-unsent-words]').map((el) => el.textContent ?? '');
const transcript = (m: Mounted): string[] =>
  m.all('.tmc__conv .msg__text').map((el) => el.textContent ?? '');
const operationsSent = (api: ReturnType<typeof server>): unknown[] =>
  api.sent.map((send) => send.body['operationId']);

// eslint-disable-next-line max-lines-per-function -- one screen, the ticket's lines
describe('a failed chat send keeps the person’s words', () => {
  it('a refused direct send keeps its words under the conversation, out of the composer and the transcript', async () => {
    const { api, m } = await team();
    api.state.refuse = {
      refused: true,
      code: 'FIELD_VALUE_INVALID',
      names: ['body'],
      fixes: ['Write the message before sending it.'],
    };
    await sendWords(m, CANARY);
    await until('the refusal drawn', () => m.find('[role="alert"]') !== null);
    expect(unsent(m)).toEqual([CANARY]);
    expect(composer(m)).toBe('');
    expect(transcript(m)).not.toContain(CANARY);
    expect(m.find('.tmc__unsent [data-unsent="refused"] [data-unsent-edit]')).not.toBeNull();
  });

  it('a direct send the API answers 503 keeps its words in the box and offers Resend', async () => {
    const { api, m } = await team();
    api.state.unanswered = 'before';
    await sendWords(m, CANARY);
    await until('the failure drawn', () => m.find('[role="alert"]') !== null);
    expect(unsent(m)).toEqual([CANARY]);
    expect(composer(m)).toBe(CANARY);
    expect(transcript(m)).not.toContain(CANARY);
    expect(
      m.find('.tmc__unsent [data-unsent="unanswered"] [data-unsent-resend]')?.textContent,
    ).toBe('Resend');
  });

  it('a resend after a lost answer reuses the first operation id and the message posts once', async () => {
    const { api, m } = await team();
    api.state.unanswered = 'after';
    await sendWords(m, CANARY);
    await until('the lost answer drawn', () => unsent(m).length === 1);
    api.state.unanswered = null;
    await m.click('.tmc__unsent [data-unsent-resend]');
    await until('the resend taken', () => unsent(m).length === 0);
    const [first, second] = operationsSent(api);
    expect(api.sent).toHaveLength(2);
    expect(second).toBe(first);
    expect([...api.posted.values()]).toEqual([CANARY]);
  });

  it('a refused send edited back into the empty composer leaves the outbox, and its next send is a new operation', async () => {
    const { api, m } = await team();
    api.state.refuse = { refused: true, code: 'FIELD_VALUE_INVALID', names: ['body'], fixes: [] };
    await sendWords(m, CANARY);
    await until('the refusal kept', () => unsent(m).length === 1);
    await m.click('.tmc__unsent [data-unsent-edit]');
    expect(composer(m)).toBe(CANARY);
    expect(unsent(m)).toEqual([]);
    api.state.refuse = null;
    await sendWords(m, `${CANARY} fixed`);
    await until('the second send', () => api.sent.length === 2);
    const [first, second] = operationsSent(api);
    expect(second).not.toBe(first);
  });

  it('Edit never writes over words already in the composer', async () => {
    const { api, m } = await team();
    api.state.refuse = { refused: true, code: 'FIELD_VALUE_INVALID', names: ['body'], fixes: [] };
    await sendWords(m, CANARY);
    await until('the refusal kept', () => unsent(m).length === 1);
    await m.type('.tmc__conv .composer input', 'newer words');
    expect((m.find('.tmc__unsent [data-unsent-edit]') as HTMLButtonElement | null)?.disabled).toBe(
      true,
    );
    expect(composer(m)).toBe('newer words');
    expect(unsent(m)).toEqual([CANARY]);
  });

  it('two sends failing at once both keep their words', async () => {
    const { api, m } = await team();
    api.state.unanswered = 'before';
    await sendWords(m, 'first words');
    await sendWords(m, 'second words');
    await until('both kept', () => unsent(m).length === 2);
    expect(unsent(m)).toEqual(['first words', 'second words']);
  });

  it('a refused group send survives a switch to a direct conversation and back', async () => {
    const { api, m } = await team();
    await m.click(`[data-group="${GROUP}"]`);
    api.state.refuse = { refused: true, code: 'FIELD_VALUE_INVALID', names: ['body'], fixes: [] };
    await sendWords(m, CANARY);
    await until('the refusal kept', () => unsent(m).length === 1);
    await m.click('[data-person="p-bo"] .tmc__face');
    expect(unsent(m)).toEqual([]);
    await m.click(`[data-group="${GROUP}"]`);
    expect(unsent(m)).toEqual([CANARY]);
  });

  it('Discard lets the words go', async () => {
    const { api, m } = await team();
    api.state.unanswered = 'before';
    await sendWords(m, CANARY);
    await until('kept', () => unsent(m).length === 1);
    await m.click('.tmc__unsent [data-unsent-discard]');
    expect(unsent(m)).toEqual([]);
  });

  it('a reload after a failed send still shows the unsent words, and Resend reuses their operation id', async () => {
    const storage = memoryStorage();
    const first = await team(server(), storage);
    first.api.state.unanswered = 'after';
    await sendWords(first.m, CANARY);
    await until('kept', () => unsent(first.m).length === 1);
    await view?.unmount();
    const again = await team(server(), storage);
    expect(unsent(again.m)).toEqual([CANARY]);
    await again.m.click('.tmc__unsent [data-unsent-resend]');
    await until('taken', () => unsent(again.m).length === 0);
    expect(operationsSent(again.api)).toEqual(operationsSent(first.api));
  });

  it('another sign-in in the same tab never sees the unsent words, and its screen clears them from the tab', async () => {
    const storage = memoryStorage();
    const first = await team(server(), storage);
    first.api.state.unanswered = 'before';
    await sendWords(first.m, CANARY);
    await until('kept', () => unsent(first.m).length === 1);
    await view?.unmount();
    const other = await team(server(), storage, 'bravo:bea@example.test:1');
    expect(unsent(other.m)).toEqual([]);
    expect(other.m.host.textContent).not.toContain(CANARY);
    expect(storage.getItem('ops-astro.chat-unsent')).toBeNull();
  });

  it('an answer landing after a switch of sign-in never overwrites the next sign-in’s kept words', () => {
    const storage = memoryStorage();
    const before = new ChatOutbox('alpha:ana@example.test:0', storage);
    const leave = before.mount();
    const old = { id: '00000000-0000-4000-8000-000000000001', to: 'p-bo', body: 'old words' };
    before.sending({ ...old, kind: 'direct', state: 'sending' });
    leave();
    const after = new ChatOutbox('bravo:bea@example.test:1', storage);
    after.mount();
    const kept = { id: '00000000-0000-4000-8000-000000000002', to: 'p-cy', body: CANARY };
    after.sending({ ...kept, kind: 'direct', state: 'sending' });
    before.answered(old.id, 'refused');
    const again = new ChatOutbox('bravo:bea@example.test:1', storage);
    expect(again.snapshot().map((one) => one.body)).toEqual([CANARY]);
  });
});
