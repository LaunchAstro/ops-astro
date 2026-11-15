// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Words typed into a time note while its save is out are still in the box
// after the save's answer and the task page's reread that follows it.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { json, mount, press, typeInto, unmountAll } from './perspective-support.tsx';
import { task, tick } from './task-page-stub.tsx';

afterEach(unmountAll);

/**
 * A task page server: the first read answers, a later read and the note's
 * save wait for their release; the note is what the last save sent.
 */
function noteWorld() {
  const at = {
    reads: 0,
    note: 'Original',
    releaseSave: undefined as ((response: Response) => void) | undefined,
    releaseRead: undefined as ((response: Response) => void) | undefined,
  };
  const entry = () => ({
    id: 'a',
    startedAt: '2026-09-30T01:00:00Z',
    endedAt: '2026-09-30T02:00:00Z',
    minutes: 60,
    note: at.note,
    adHoc: false,
    source: 'log',
  });
  const answer = () =>
    json({
      ok: true,
      task: task({ time: { entries: [entry()], running: null, totalMinutes: 60 } }),
    });
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: async (url, init) => {
      if (String(url).endsWith('/task/read')) {
        at.reads += 1;
        if (at.reads === 1) return answer();
        return await new Promise<Response>((resolve) => {
          at.releaseRead = resolve;
        });
      }
      if (String(url).endsWith('/time/set_note')) {
        const body = JSON.parse(String(init?.body));
        at.note = body.note;
        return await new Promise<Response>((resolve) => {
          at.releaseSave = resolve;
        });
      }
      if (String(url).endsWith('/person/list')) return json({ ok: true, persons: [] });
      return new Response(null, { status: 503 });
    },
  });
  return { at, answer, client };
}

it('a time note typed while its save was out survives the task page reread after the answer', async () => {
  const { at, answer, client } = noteWorld();
  const view = await mount(
    <TaskDetailScreen client={client} grantKey="alpha:member" taskKey="Proj-Verity-Pacing" />,
  );
  await tick();
  await view.click('[data-time-note="a"]');
  await typeInto(view, 'input[data-time-note-edit]', 'First edit');
  await press(view, 'input[data-time-note-edit]', 'Enter');
  expect(at.note).toBe('First edit');
  await typeInto(view, 'input[data-time-note-edit]', 'Second edit');
  await act(() => {
    at.releaseSave?.(json({ recordId: 'a', revision: 5 }));
  });
  await tick();
  expect(at.reads).toBe(2);
  await act(() => {
    at.releaseRead?.(answer());
  });
  await tick();
  expect(
    (view.find('input[data-time-note-edit]') as HTMLInputElement | null)?.value,
    'the page reread must retain the unsent Second edit',
  ).toBe('Second edit');
});
