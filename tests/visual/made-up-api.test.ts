// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { READ_NAMES } from '../../apps/web/src/operations/read-names.ts';
import type { ReadName } from '../../apps/web/src/operations/read-names.ts';
import {
  pathOf,
  PREFIX,
  type ChatConversationsResult,
  type ChatMessagesResult,
} from '../../packages/core-wire/src/index.ts';
import { MADE_UP_READS, madeUpAnswer, MOCKUP_TASK_KEY, TASKS } from './made-up-api.ts';

// Reads no screen draws at the harness's addresses: the preset plan is the
// command line's, the unattended list is the operations view's. No screen asks
// the breach notice drafts (the command line's drill), nor an instruction
// file's attribution yet (the command line and pre-review do), and the drawer
// reads no correction's decision while it keeps the made-up desk (C80). Each
// is drawn "could not be read" if asked. The task page's run has a receipt, so
// `task.receipt` is drawn here, and the task's client field asks the client list.
const NOT_DRAWN = new Set([
  'preset.plan',
  'inbox.unattended',
  'definition.attribution',
  // AW-13 readers: no screen draws a trace yet.
  'trace.read',
  // AW-12: no screen draws the harness result in this piece.
  'harness.read',
  'privacy.draft_breach_notices',
  'live_correction.read',
]);

const at = (name: ReadName): string => `${PREFIX.person}alpha${pathOf(name)}`;

describe('the made-up reads the width-and-theme harness draws from', () => {
  it('answers a read at the path the app asks it on, with the made-up rows', () => {
    const answer = madeUpAnswer(`${PREFIX.person}alpha${pathOf('task.board')}`);
    expect(answer).toEqual({
      status: 200,
      json: {
        ok: true,
        tasks: TASKS,
        changedAt: '2026-09-25T04:00:00.000Z',
        viewer: 'p-nathan',
        owed: 0,
      },
    });
  });

  it('answers the live stream as down, so nothing streams into a capture', () => {
    expect(madeUpAnswer(`${PREFIX.person}alpha/live`)).toEqual({ status: 503 });
    expect(madeUpAnswer(`${PREFIX.person}alpha/live/task/T-1`)).toEqual({ status: 503 });
  });

  it('leaves an address it does not know to the network', () => {
    expect(madeUpAnswer('/api/sign-in')).toBeUndefined();
    expect(madeUpAnswer(`${PREFIX.person}alpha${pathOf('task.create')}`)).toBeUndefined();
  });

  it('answers every read a screen draws, so a new read is a decision here', () => {
    const drawn = READ_NAMES.filter((name) => !NOT_DRAWN.has(name));
    expect([...MADE_UP_READS].toSorted()).toEqual([...drawn].toSorted());
  });

  it("answers each conversation's messages by its id, unread as the panel derives it", () => {
    const list = (madeUpAnswer(at('chat.conversations')) as { json: ChatConversationsResult }).json;
    expect(list.conversations.map((view) => view.kind).toSorted()).toEqual(['direct', 'group']);
    for (const view of list.conversations) {
      const { conversationId } = view;
      const read = madeUpAnswer(at('chat.messages'), {}, { conversationId });
      const held = (read as { json: ChatMessagesResult }).json;
      expect(held.conversationId).toBe(conversationId);
      expect(held.lastRead).toBe(view.lastRead);
      expect(held.messages.at(-1)?.at).toBe(view.lastMessageAt);
      const unread = held.messages.filter(
        (m) => m.authorId !== 'p-nathan' && m.at > (view.lastRead ?? ''),
      );
      expect(unread).toHaveLength(view.unread);
    }
    expect(madeUpAnswer(at('chat.messages'), {}, { conversationId: 'cv-none' })).toBeUndefined();
  });
});

// The read states (UI-STATES): a variant answers the named reads in another
// state, so the harness can photograph a board with no rows, a task that could
// not be read, a refusal and a read still in flight. Every other read keeps its
// default answer.
describe('the made-up reads in another state', () => {
  const board = `${PREFIX.person}alpha${pathOf('task.board')}`;
  const task = `${PREFIX.person}alpha${pathOf('task.read')}`;

  it('answers a read named empty with no rows, and the rest as before', () => {
    expect(madeUpAnswer(board, { empty: ['task.board'] })).toEqual({
      status: 200,
      json: { ok: true, tasks: [], changedAt: null, viewer: 'p-nathan', owed: 0 },
    });
    expect(madeUpAnswer(task, { empty: ['task.board'] })).toEqual(madeUpAnswer(task));
  });

  it('answers a read named unavailable as a server failure with no refusal body', () => {
    expect(madeUpAnswer(task, { unavailable: ['task.read'] })).toEqual({ status: 503 });
  });

  it("answers a read named refused with the server's one refusal shape", () => {
    expect(madeUpAnswer(board, { refused: ['task.board'] })).toEqual({
      status: 403,
      json: { refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] },
    });
  });

  it('holds a read named pending, so the screen stays on its loading state', () => {
    expect(madeUpAnswer(board, { pending: ['task.board'] })).toEqual({ pending: true });
  });

  it('answers exactly as the default with an empty variant', () => {
    expect(madeUpAnswer(board, {})).toEqual(madeUpAnswer(board));
  });

  it("reads the mockup task page's task unranked, as its strip draws it, and any other ranked", () => {
    const read = `${PREFIX.person}alpha${pathOf('task.read')}`;
    const rankOf = (recordId: string) => {
      const answer = madeUpAnswer(read, {}, { recordId });
      if (answer === undefined || !('json' in answer)) throw new Error('task.read not answered');
      return (answer.json as { task: { rank: { number: number | null } } }).task.rank.number;
    };
    expect(rankOf(MOCKUP_TASK_KEY)).toBeNull();
    expect(rankOf('T-1')).toBe(1);
  });
});
