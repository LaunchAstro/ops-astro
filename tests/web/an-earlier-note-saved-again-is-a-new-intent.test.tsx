// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A time note whose answer was lost, then a different note saved, then the
// first note typed again: the last is a new intent with its own operation,
// not a replay of the first one's stored answer.

import { expect, it } from 'vitest';
import { mount, settle } from '../surfaces/mount.tsx';
import { TimeLog } from '../../apps/web/src/screens/task/Time.tsx';
import { press } from './perspective-support.tsx';
import { raceServer, stored } from './write-race-support.tsx';

it('returning to an earlier note after another save is a new intent', async () => {
  let savedNote = 'Original';
  const api = raceServer((_path, body) => {
    savedNote = String(body['note']);
    return stored(1);
  });
  const entry = {
    id: 'a',
    startedAt: '2026-09-30T01:00:00.000Z',
    endedAt: '2026-09-30T02:00:00.000Z',
    minutes: 60,
    note: 'Original',
    adHoc: false,
    source: 'log',
  } as const;
  const view = await mount(
    <TimeLog
      client={api.client}
      taskId="task"
      time={{ entries: [entry], running: null, totalMinutes: 60 }}
      estimateMinutes={null}
      showAll={false}
      onShowAll={() => {}}
      onChanged={() => {}}
    />,
  );
  const box = 'input[data-time-note-edit]';
  await view.click('[data-time-note="a"]');
  api.fates.push('lose');
  await view.type(box, 'First note');
  await press(view, box, 'Enter');
  await settle();
  expect(savedNote).toBe('First note');
  await view.type(box, 'Second note');
  await press(view, box, 'Enter');
  await settle();
  expect(savedNote).toBe('Second note');
  await view.click('[data-time-note="a"]');
  await view.type(box, 'First note');
  await press(view, box, 'Enter');
  await settle();
  expect(
    savedNote,
    'an intentional later save must restore First note, rather than replay its old receipt',
  ).toBe('First note');
});
