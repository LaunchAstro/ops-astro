// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A time entry's note is saved with Enter, and its answer closes the box only
// when the box still holds the words it sent. Raced here: two tabs saving one
// entry's note at once, answered in both orders; the answer lost before and
// after the server stored it, and after the box was left; and the retry, which
// must reuse the operation id while the outcome is unknown and mint a new one
// after a refusal.

import { afterEach, describe, expect, it } from 'vitest';
import { TimeLog } from '../../apps/web/src/screens/task/Time.tsx';
import type { Mounted } from '../surfaces/mount.tsx';
import { mount, press, typeInto, unmountAll } from './perspective-support.tsx';
import {
  BOTH_ORDERS,
  idOf,
  raceServer,
  refused,
  releaseHeld,
  stored,
} from './write-race-support.tsx';
import { tick } from './task-page-stub.tsx';

afterEach(unmountAll);

const ENTRY = {
  id: 'a',
  startedAt: '2026-09-30T01:00:00.000Z',
  endedAt: '2026-09-30T02:00:00.000Z',
  minutes: 60,
  note: 'Original',
  adHoc: false,
  source: 'log',
} as const;

const BOX = 'input[data-time-note-edit]';

function world() {
  const record = { note: 'Original', refuse: false };
  const api = raceServer((_path, body) => {
    if (record.refuse) return refused('NOT_FOUND', 404);
    record.note = String(body['note']);
    return stored(1);
  });
  return { record, ...api };
}

type World = ReturnType<typeof world>;

async function timeLog(api: World) {
  const counted = { changed: 0 };
  const view = await mount(
    <TimeLog
      client={api.client}
      taskId="task"
      time={{ entries: [ENTRY], running: null, totalMinutes: 60 }}
      estimateMinutes={null}
      showAll={false}
      onShowAll={() => {}}
      onChanged={() => (counted.changed += 1)}
    />,
  );
  return { view, counted };
}

async function saveNote(view: Mounted, note: string): Promise<void> {
  await view.click('[data-time-note="a"]');
  await typeInto(view, BOX, note);
  await press(view, BOX, 'Enter');
  await tick();
}

const boxValue = (view: Mounted): string | undefined =>
  view.host.querySelector<HTMLInputElement>('input[data-time-note-edit]')?.value;

describe('two tabs saving one entry’s note at once', () => {
  it.each(BOTH_ORDERS)('answered %s, each box closes on its own answer', async (_, x, y) => {
    const api = world();
    const a = await timeLog(api);
    const b = await timeLog(api);
    api.fates.push('hold', 'hold');
    await saveNote(a.view, 'From A');
    await saveNote(b.view, 'From B');
    await releaseHeld(api.held, x);
    await releaseHeld(api.held, y);
    expect(api.record.note).toBe('From B');
    expect([boxValue(a.view), boxValue(b.view)]).toStrictEqual([undefined, undefined]);
    expect([a.counted.changed, b.counted.changed]).toStrictEqual([1, 1]);
  });
});

describe('a note whose answer is lost', () => {
  it('before it reached the server: the box keeps the words and Enter sends them', async () => {
    const api = world();
    const { view, counted } = await timeLog(api);
    api.fates.push('unreachable');
    await saveNote(view, 'New note');
    expect(api.sent).toHaveLength(0);
    expect(boxValue(view)).toBe('New note');
    await press(view, BOX, 'Enter');
    await tick();
    expect(api.record.note).toBe('New note');
    expect(boxValue(view)).toBeUndefined();
    expect(counted.changed).toBe(1);
  });

  it('after the server stored it: the box keeps the words, nothing counted yet', async () => {
    const api = world();
    const { view, counted } = await timeLog(api);
    api.fates.push('lose');
    await saveNote(view, 'New note');
    expect(api.record.note).toBe('New note');
    expect(boxValue(view)).toBe('New note');
    expect(counted.changed).toBe(0);
  });

  it('answered after Escape left the box: it stays closed and the note is counted', async () => {
    const api = world();
    const { view, counted } = await timeLog(api);
    api.fates.push('hold');
    await saveNote(view, 'New note');
    await press(view, BOX, 'Escape');
    await releaseHeld(api.held, 0);
    expect(boxValue(view)).toBeUndefined();
    expect(counted.changed).toBe(1);
  });
});

describe('a note saved again', () => {
  it('after a refusal is a new operation', async () => {
    const api = world();
    api.record.refuse = true;
    const { view } = await timeLog(api);
    await saveNote(view, 'New note');
    expect(boxValue(view)).toBe('New note');
    await press(view, BOX, 'Enter');
    await tick();
    expect(api.sent).toHaveLength(2);
    expect(idOf(api.sent, 1)).not.toBe(idOf(api.sent, 0));
  });
});
