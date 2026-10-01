// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { READ_NAMES } from '../../apps/web/src/operations/read-names.ts';
import { pathOf, PREFIX } from '../../packages/core-wire/src/index.ts';
import { MADE_UP_READS, madeUpAnswer, TASKS } from './made-up-api.ts';

// Reads no batch/1 screen draws at the harness's addresses: the preset plan is
// the command line's, and the unattended list is the operations view's. Each is
// drawn "could not be read" if asked. The task page's run has a receipt.
const NOT_DRAWN = new Set(['preset.plan', 'inbox.unattended']);

describe('the made-up reads the width-and-theme harness draws from', () => {
  it('answers a read at the path the app asks it on, with the made-up rows', () => {
    const answer = madeUpAnswer(`${PREFIX.person}alpha${pathOf('task.board')}`);
    expect(answer).toEqual({ status: 200, json: { ok: true, tasks: TASKS } });
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
      json: { ok: true, tasks: [] },
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
});
