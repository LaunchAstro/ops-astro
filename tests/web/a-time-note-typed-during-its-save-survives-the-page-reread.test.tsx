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

it('a time note typed while its save was out survives the task page reread after the answer', async () => {
  let reads = 0;
  let note = 'Original';
  let releaseSave: ((response: Response) => void) | undefined;
  let releaseRead: ((response: Response) => void) | undefined;
  const entry = () => ({
    id: 'a',
    startedAt: '2026-09-30T01:00:00Z',
    endedAt: '2026-09-30T02:00:00Z',
    minutes: 60,
    note,
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
        reads += 1;
        if (reads === 1) return answer();
        return await new Promise<Response>((resolve) => {
          releaseRead = resolve;
        });
      }
      if (String(url).endsWith('/time/set_note')) {
        const body = JSON.parse(String(init?.body));
        note = body.note;
        return await new Promise<Response>((resolve) => {
          releaseSave = resolve;
        });
      }
      if (String(url).endsWith('/person/list')) return json({ ok: true, persons: [] });
      return new Response(null, { status: 503 });
    },
  });
  const view = await mount(
    <TaskDetailScreen client={client} grantKey="alpha:member" taskKey="Proj-Verity-Pacing" />,
  );
  await tick();
  await view.click('[data-time-note="a"]');
  await typeInto(view, 'input[data-time-note-edit]', 'First edit');
  await press(view, 'input[data-time-note-edit]', 'Enter');
  expect(note).toBe('First edit');
  await typeInto(view, 'input[data-time-note-edit]', 'Second edit');
  await act(() => {
    releaseSave?.(json({ recordId: 'a', revision: 5 }));
  });
  await tick();
  expect(reads).toBe(2);
  await act(() => {
    releaseRead?.(answer());
  });
  await tick();
  expect(
    (view.find('input[data-time-note-edit]') as HTMLInputElement | null)?.value,
    'the page reread must retain the unsent Second edit',
  ).toBe('Second edit');
});
