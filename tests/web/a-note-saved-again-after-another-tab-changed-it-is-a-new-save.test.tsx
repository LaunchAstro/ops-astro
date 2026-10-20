// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A note whose save lost its answer, then read back changed by another tab,
// is saved afresh when the earlier words are typed again: never under the
// lost save's id, which the server would answer with its stored receipt.

import { afterEach, expect, it } from 'vitest';
import { TimeLog } from '../../apps/web/src/screens/task/Time.tsx';
import { mount, press, typeInto, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
import { raceServer, stored } from './write-race-support.tsx';

afterEach(unmountAll);

it('a note saved again after another tab changed it is a new save, not the lost one replayed', async () => {
  let saved = 'Original';
  const api = raceServer((_path, body) => {
    saved = String(body['note']);
    return stored(1);
  });
  const show = (note: string) => (
    <TimeLog
      client={api.client}
      taskId="task"
      time={{
        entries: [
          {
            id: 'a',
            startedAt: '2026-09-30T01:00:00Z',
            endedAt: '2026-09-30T02:00:00Z',
            minutes: 60,
            note,
            adHoc: false,
            source: 'log',
          },
        ],
        running: null,
        totalMinutes: 60,
      }}
      estimateMinutes={null}
      showAll={false}
      onShowAll={() => {}}
      onChanged={() => {}}
    />
  );
  const a = await mount(show('Original'));
  const b = await mount(show('Original'));
  const box = 'input[data-time-note-edit]';
  await a.click('[data-time-note="a"]');
  await typeInto(a, box, 'First note');
  api.fates.push('lose');
  await press(a, box, 'Enter');
  await tick();
  expect(saved).toBe('First note');
  await press(a, box, 'Escape');
  await b.click('[data-time-note="a"]');
  await typeInto(b, box, 'Second note');
  await press(b, box, 'Enter');
  await tick();
  expect(saved).toBe('Second note');
  // A live read in the still-mounted panel now shows the colleague's saved note.
  await a.render(show(saved));
  expect(a.find('[data-time-note="a"]')?.textContent).toBe('Second note');
  await a.click('[data-time-note="a"]');
  await typeInto(a, box, 'First note');
  await press(a, box, 'Enter');
  await tick();
  expect(a.find(box)).toBeNull();
  expect(saved, 'this explicit save must restore First note after seeing Second note').toBe(
    'First note',
  );
});
