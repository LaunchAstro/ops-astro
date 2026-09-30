// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-6: the time section on the task page's Team side (CS-4.1, CS-4.28 to
// CS-4.31). Start and Stop drive the person's one timer through `time.start`
// and `time.stop`; the log box takes what a person types and sends it as
// `time.log` on Enter or Log; the latest three entries show, then a fold; a
// note edits inline by keyboard through `time.set_note`; an entry deletes
// through `time.delete`; the burn bar turns danger over the estimate. Every
// entry drawn is one the server sent: the reader's own (RS-VAULT-9).

import { act, useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskTimeView, TimeEntryView } from '../../packages/core-wire/src/index.ts';
import { burnOf, minutesText, TimeLog } from '../../apps/web/src/screens/task/Time.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type { Mounted } from '../surfaces/mount.tsx';
import { TASK_ID, tick } from './task-page-stub.tsx';
import { json, mount, press, unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

interface Sent {
  readonly command: string;
  readonly body: Readonly<Record<string, unknown>>;
}

const entry = (id: string, minutes: number | null, note = ''): TimeEntryView => ({
  id,
  startedAt: '2026-09-30T01:00:00.000Z',
  endedAt: minutes === null ? null : '2026-09-30T02:00:00.000Z',
  minutes,
  note,
  adHoc: false,
  source: 'log',
});

const timeWith = (entries: readonly TimeEntryView[], over: Partial<TaskTimeView> = {}) => ({
  entries,
  running: null,
  totalMinutes: entries.reduce((sum, each) => sum + (each.minutes ?? 0), 0),
  ...over,
});

/** Records each command; answers every one as applied. */
function commands() {
  const sent: Sent[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const command = at.slice(at.lastIndexOf('/b/alpha/') + 9).replace('/', '.');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'];
    sent.push({ command, body });
    return Promise.resolve(json({ ok: true, recordId: null, revision: null, detail: {} }));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { client, sent };
}

/** The section under a parent that rereads on change, redrawing the server's next time. */
async function section(
  time: TaskTimeView,
  next: TaskTimeView = time,
  estimate: number | null = null,
) {
  const { client, sent } = commands();
  const counter = { rereads: 0 };
  function Parent(): ReactElement {
    const [shown, setShown] = useState(time);
    const [all, setAll] = useState(false);
    return (
      <TimeLog
        client={client}
        taskId={TASK_ID}
        time={shown}
        estimateMinutes={estimate}
        showAll={all}
        onShowAll={setAll}
        onChanged={() => {
          counter.rereads += 1;
          setShown(next);
        }}
      />
    );
  }
  const view = await mount(<Parent />);
  return { view, sent, rereads: () => counter.rereads };
}

const find = <T extends HTMLElement = HTMLElement>(view: Mounted, selector: string): T => {
  const found = view.host.querySelector<T>(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
};

const click = async (view: Mounted, selector: string) => {
  const target = find(view, selector);
  await act(() => {
    target.click();
  });
  await tick();
};

const typeInto = async (view: Mounted, selector: string, value: string) => {
  const input = find<HTMLInputElement>(view, selector);
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
};

const shownEntries = (view: Mounted): readonly string[] =>
  [...view.host.querySelectorAll<HTMLElement>('[data-time-entry]')].map(
    (row) => row.dataset['timeEntry'] ?? '',
  );

describe('MP-4-6 timer start and stop, on the page', () => {
  it('CS-4.1: Start sends time.start for this task; the reread shows Stop, which sends time.stop', async () => {
    const running = timeWith([], {
      running: { entryId: 'e-run', startedAt: '2026-09-30T01:00:00.000Z' },
    });
    const { view, sent, rereads } = await section(timeWith([]), running);
    expect(find(view, '[data-timer]').textContent).toContain('Start');
    await click(view, '[data-timer]');
    expect(sent.map((each) => [each.command, each.body['taskId']])).toStrictEqual([
      ['time.start', TASK_ID],
    ]);
    expect(rereads()).toBe(1);
    expect(find(view, '[data-timer]').dataset['running']).toBe('true');
    expect(find(view, '[data-timer]').textContent).toContain('Stop');
    await click(view, '[data-timer]');
    expect(sent.map((each) => each.command)).toStrictEqual(['time.start', 'time.stop']);
    expect(sent[1]?.body['taskId']).toBe(TASK_ID);
  });
});

describe('MP-4-6 log by Enter or Log', () => {
  it('CS-4.28: Enter sends what was typed as time.log and clears the box', async () => {
    const { view, sent } = await section(timeWith([]));
    const box = await typeInto(view, 'input[data-time-log]', '1h 30m');
    box.focus();
    await press(view, 'input[data-time-log]', 'Enter');
    await tick();
    expect(sent.map((each) => [each.command, each.body['duration']])).toStrictEqual([
      ['time.log', '1h 30m'],
    ]);
    expect(sent[0]?.body['taskId']).toBe(TASK_ID);
    expect(find<HTMLInputElement>(view, 'input[data-time-log]').value).toBe('');
  });

  it('the Log button sends it too, and an empty box sends nothing', async () => {
    const { view, sent } = await section(timeWith([]));
    await click(view, '[data-time-log-add]');
    expect(sent).toHaveLength(0);
    await typeInto(view, 'input[data-time-log]', '90');
    await click(view, '[data-time-log-add]');
    expect(sent.map((each) => [each.command, each.body['duration']])).toStrictEqual([
      ['time.log', '90'],
    ]);
  });
});

describe('MP-4-6 three entries then a fold', () => {
  it('CS-4.31: the latest three show, then Show all (5) opens the rest and folds them again', async () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((id) => entry(id, 10));
    const { view } = await section(timeWith(five));
    expect(shownEntries(view)).toStrictEqual(['a', 'b', 'c']);
    expect(find(view, '[data-time-fold]').textContent).toBe('Show all (5)');
    await click(view, '[data-time-fold]');
    expect(shownEntries(view)).toStrictEqual(['a', 'b', 'c', 'd', 'e']);
    await click(view, '[data-time-fold]');
    expect(shownEntries(view)).toStrictEqual(['a', 'b', 'c']);
  });

  it('three or fewer draw no fold', async () => {
    const { view } = await section(timeWith([entry('a', 10)]));
    expect(view.host.querySelector('[data-time-fold]')).toBeNull();
  });
});

describe('MP-4-6 a note edits inline by keyboard', () => {
  it('CS-4.29: Enter on the note opens it, Enter saves through time.set_note, Escape sends nothing', async () => {
    const { view, sent } = await section(timeWith([entry('a', 30, 'first')]));
    find(view, '[data-time-note="a"]').focus();
    await press(view, '[data-time-note="a"]', 'Enter');
    await typeInto(view, 'input[data-time-note-edit]', 'drafting');
    await press(view, 'input[data-time-note-edit]', 'Enter');
    await tick();
    expect(
      sent.map((each) => [each.command, each.body['entryId'], each.body['note']]),
    ).toStrictEqual([['time.set_note', 'a', 'drafting']]);
    await press(view, '[data-time-note="a"]', 'Enter');
    await typeInto(view, 'input[data-time-note-edit]', 'dropped');
    await press(view, 'input[data-time-note-edit]', 'Escape');
    expect(sent).toHaveLength(1);
    expect(view.host.querySelector('input[data-time-note-edit]')).toBeNull();
  });
});

describe('MP-4-6 entries delete', () => {
  it('CS-4.30: Delete sends time.delete for that entry; a running one offers no delete', async () => {
    const running = entry('r', null);
    const { view, sent } = await section(
      timeWith([running, entry('a', 30)], {
        running: { entryId: 'r', startedAt: running.startedAt },
      }),
    );
    expect(view.host.querySelector('[data-time-delete="r"]')).toBeNull();
    await click(view, '[data-time-delete="a"]');
    expect(sent.map((each) => [each.command, each.body['entryId']])).toStrictEqual([
      ['time.delete', 'a'],
    ]);
  });
});

describe('MP-4-6 the burn bar turns danger over the estimate', () => {
  it('reads the total against the estimate, danger only over it, and draws nothing with no estimate', async () => {
    expect(burnOf(30, 60)).toStrictEqual({ percent: 50, danger: false });
    expect(burnOf(60, 60)).toStrictEqual({ percent: 100, danger: false });
    expect(burnOf(90, 60)).toStrictEqual({ percent: 100, danger: true });
    expect(burnOf(90, null)).toBeNull();
    const over = await section(timeWith([entry('a', 90)]), undefined, 60);
    expect(find(over.view, '[data-time-burn]').dataset['danger']).toBe('true');
    const none = await section(timeWith([entry('a', 90)]));
    expect(none.view.host.querySelector('[data-time-burn]')).toBeNull();
    expect(find(none.view, '[data-time-total]').textContent).toContain('1h 30m');
  });

  it('writes minutes as a person reads them', () => {
    expect([minutesText(5), minutesText(60), minutesText(90), minutesText(125)]).toStrictEqual([
      '5m',
      '1h',
      '1h 30m',
      '2h 5m',
    ]);
  });
});
