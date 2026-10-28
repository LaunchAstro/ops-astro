// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { timerWorld } from './task-bound-timer-support.tsx';
import { realm } from './task-timer-recovery-support.tsx';

it('a refused timer retry from another task reads the held timer task before letting go', async () => {
  const world = timerWorld();
  // The Start commits, but its reply is lost. Current reads can reveal the running timer.
  world.loseStart();
  let refuse = false;
  const fetch: typeof globalThis.fetch = (url, init) => {
    if (String(url).endsWith('/time/start') && refuse)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refused: true,
            code: 'SCOPE_NOT_GRANTED',
            names: [],
            fixes: [],
          }),
          { status: 403 },
        ),
      );
    return world.fetch(url, init);
  };
  const app = await realm(fetch);
  await app.view.click('main [data-time-log-section] [data-timer]');
  await app.tick();
  expect(app.view.text()).toContain('Timer outcome unknown');
  await app.renderPath('/task/Timer-B');
  await app.tick();
  const heldReads = () =>
    world.sent.filter(
      (call) =>
        call.path === '/task/read' &&
        ['Timer-A', '11111111-1111-4111-8111-111111111111'].includes(String(call.body['recordId'])),
    ).length;
  const before = heldReads();
  refuse = true;
  await app.view.click('[data-task-timer-retry]');
  await app.tick();
  await app.tick();
  expect(
    app.view
      .all('button')
      .some((button) => /Stop waiting for this change/u.test(button.textContent ?? '')),
  ).toBe(true);
  expect(
    heldReads(),
    'read current time after refusal, before asking the person to let go',
  ).toBeGreaterThan(before);
  expect(app.view.find('[data-task-timer-strip] [data-timer]')?.textContent).toContain('Stop');
});
