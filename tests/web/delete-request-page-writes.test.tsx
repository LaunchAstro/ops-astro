// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// #2359 (Sol S2405-1 and round 3): Confirm delete and Keep wait while any
// other write on the task page is in flight: an assignment, a comment, a
// launch or a score change.

import { afterEach, expect, it } from 'vitest';
import { chooseHouse } from './p08-rank-marks-select-support.tsx';
import { mount, typeInto, unmountAll } from './perspective-support.tsx';
import { task, tick } from './task-page-stub.tsx';
import { APPLIED, REQUEST, buttons, livePage } from './delete-request-support.tsx';

afterEach(unmountAll);

it('the task page holds the answers while another control’s write is in flight (S2405-1)', async () => {
  const mine = [{ agentId: 'd-mine-2', name: 'Inbox triage' }];
  const { view, sent, release } = await livePage(
    [task({ deleteRequest: REQUEST, myAgents: mine })],
    APPLIED,
    'task.assign',
  );
  expect(buttons(view)).toStrictEqual([false, false]);
  await view.choose('#page-assign-ai', 'd-mine-2');
  await tick();
  expect(sent).toContain('task.assign');
  expect(buttons(view), 'held while the assignment is in flight').toStrictEqual([true, true]);
  await view.click('[data-act="confirm-delete"] button');
  await tick();
  expect(sent).not.toContain('task.confirm_delete');
  release();
  await tick();
  expect(buttons(view), 'free once it settles').toStrictEqual([false, false]);
});

const AGENT = {
  agent: {
    agentId: 'a-1',
    name: 'Reply drafter',
    owner: { personId: 'p-ada', name: 'Ada' },
    live: false,
    run: null,
  },
  myAgents: [],
};

it.each([
  [
    'task.comment',
    {},
    async (view: Awaited<ReturnType<typeof mount>>) => {
      await typeInto(view, '#comment-body', 'A note while the request waits.');
      await view.click('[data-comment="post"]');
    },
  ],
  [
    'task.launch',
    AGENT,
    async (view: Awaited<ReturnType<typeof mount>>) => {
      await view.click('[data-launch-run]');
    },
  ],
  [
    'task.set_scores',
    { scores: { impact: 7, confidence: 9, ease: 8 } },
    async (view: Awaited<ReturnType<typeof mount>>) => {
      const trigger = view.host.querySelector<HTMLButtonElement>('#page-score-impact button');
      if (trigger === null) throw new Error('no page score editor for impact');
      await chooseHouse(trigger, '5');
    },
  ],
] as const)(
  'the task page holds the answers while %s is in flight',
  async (command, over, write) => {
    const { view, sent, release } = await livePage(
      [task({ deleteRequest: REQUEST, ...over })],
      APPLIED,
      command,
    );
    expect(buttons(view)).toStrictEqual([false, false]);
    await write(view);
    await tick();
    expect(sent, JSON.stringify(sent)).toContain(command);
    expect(buttons(view), `held while ${command} is in flight`).toStrictEqual([true, true]);
    await view.click('[data-act="confirm-delete"] button');
    await tick();
    expect(sent).not.toContain('task.confirm_delete');
    release();
    await tick();
    expect(buttons(view), 'free once it settles').toStrictEqual([false, false]);
  },
);
