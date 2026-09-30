// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { READ_NAMES } from '../../apps/web/src/operations/read-names.ts';
import { pathOf, PREFIX } from '../../packages/core-wire/src/index.ts';
import { MADE_UP_READS, madeUpAnswer, TASKS } from './made-up-api.ts';

// Reads no screen draws at the harness's addresses: a receipt needs a
// finished run, the preset plan is the command line's, and the unattended list
// is the operations view's. No screen asks the client list, the preference
// store (the section tip is not wired yet) or the breach notice drafts (the
// command line's drill). Each is drawn "could not be read" if asked.
const NOT_DRAWN = new Set([
  'task.receipt',
  'preset.plan',
  'inbox.unattended',
  'client.list',
  'preference.read',
  'privacy.draft_breach_notices',
]);

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
