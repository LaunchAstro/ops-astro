// SPDX-License-Identifier: AGPL-3.0-only
//
// #1467, the drawer's page note as pure moves: a refusal for its page takes back the note's claim
// that the page was read into context only when it answers a question asked on the page the note
// still names. A late refusal for an older page, or one answering no question, leaves the note of
// the page added since alone.

import { describe, expect, it } from 'vitest';
import {
  addPage,
  initial,
  said,
  started,
  type AssistantState,
} from '../../apps/web/src/assistant/chats.ts';

const OLD = { address: '/task/T-gone', shows: 'Task' };
const NEW = { address: '/task/T-here', shows: 'Task' };
const REFUSAL = {
  id: 'failed-9',
  role: 'failed' as const,
  body: 'Models are off for this material until a local model is available, so nothing was sent.',
  cites: [],
};
const question = (id: string) => ({ id, role: 'user' as const, body: 'What is this?', cites: [] });

const note = (state: AssistantState, key = 'chat-1'): string | undefined =>
  state.chats.find((chat) => chat.key === key)?.messages.find((line) => line.id === 'page')?.body;

describe('a page refusal and the page note', () => {
  it('takes back the claim of the page its question was asked on', () => {
    const asked = said(addPage(initial(), 'chat-1', OLD), 'chat-1', question('user-1'));
    expect(note(said(asked, 'chat-1', REFUSAL, 'user-1'))).toMatch(/couldn’t be read/u);
  });

  it('leaves a page added since alone when the refusal is for the older page', () => {
    const asked = said(addPage(initial(), 'chat-1', OLD), 'chat-1', question('user-1'));
    const replaced = addPage(asked, 'chat-1', NEW);
    expect(note(said(replaced, 'chat-1', REFUSAL, 'user-1'))).toMatch(/^Read this page into/u);
  });

  it('leaves the note alone for a refusal that answers no question', () => {
    const asked = said(addPage(initial(), 'chat-1', OLD), 'chat-1', question('user-1'));
    expect(note(said(asked, 'chat-1', REFUSAL))).toMatch(/^Read this page into/u);
  });

  it('leaves the note alone for a question asked before any page was added', () => {
    const asked = addPage(said(initial(), 'chat-1', question('user-1')), 'chat-1', OLD);
    expect(note(said(asked, 'chat-1', REFUSAL, 'user-1'))).toMatch(/^Read this page into/u);
  });

  it('keeps a folded twin’s questions, so its refusal is still matched to its page', () => {
    const twin: AssistantState = {
      ...initial(),
      chats: [
        { ...initial().chats[0]!, key: 'chat-1' },
        { ...initial().chats[0]!, key: 'chat-2', conversationId: 'c-1' },
      ],
    };
    const asked = said(addPage(twin, 'chat-2', OLD), 'chat-2', question('user-1'));
    const folded = addPage(started(asked, 'chat-1', 'c-1'), 'chat-1', OLD);
    expect(note(said(folded, 'chat-1', REFUSAL, 'user-1'))).toMatch(/couldn’t be read/u);
  });
});
