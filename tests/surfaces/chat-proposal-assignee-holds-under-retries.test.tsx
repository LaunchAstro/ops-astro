// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A chat card's assignment under timing: the create's answer before the
// assignment, and a retry of either. A second click while the first is out
// sends nothing more, a create whose answer was lost is sent again under its
// own id before any assignment, and an assignment refused as stale leaves the
// task made and says so.
// The operations client is a recorder standing in for the network only
// (`chat-proposal-drawer.tsx`).

import { afterEach, describe, expect, it } from 'vitest';
import {
  ADA,
  answered,
  CREATE,
  drawer,
  ok,
  REPLY,
  refused,
  type Answer,
} from './chat-proposal-drawer.tsx';
import { settle } from './mount.tsx';
import { track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const assignees = (sent: readonly { readonly body: Answer }[]): unknown[] =>
  sent.map((each) => (each.body['fields'] as Answer)['assignee']);

const lost: Answer = { unavailable: true, because: 'The network dropped.' };

// eslint-disable-next-line max-lines-per-function -- each timing of the card, in the page's order
describe('chat proposal assignee under retries', () => {
  it('a second click while the create is out sends one create and one assignment', async () => {
    let answer: ((value: Answer) => void) | undefined;
    const pending = new Promise<Answer>((resolve) => {
      answer = resolve;
    });
    const opened = await drawer({
      replies: [answered(CREATE)],
      writes: [pending],
    });
    track(opened.page);
    await opened.ask('We need the printer booked');
    await opened.page.click('[data-proposal="send"]');
    await opened.page.click('[data-proposal="send"]');
    answer?.(ok({ recordId: 'new-task-id', revision: 1, detail: { key: 'T-31' } }));
    await settle();
    expect(opened.writes()).toHaveLength(1);
    expect(assignees(opened.assigned())).toStrictEqual([ADA]);
  });

  it('a create whose answer was lost sends no assignment, and Send again sends the create under its id, then the one assignment', async () => {
    const opened = await drawer({
      replies: [answered(CREATE)],
      writes: [lost],
    });
    track(opened.page);
    await opened.ask('We need the printer booked');
    await opened.click();
    expect(opened.assigned()).toHaveLength(0);
    expect(opened.page.find('[data-proposal="send"]')?.textContent).toBe('Send again');
    await opened.click();
    expect(opened.writes().map((each) => each.options['operationId'])).toStrictEqual([
      `task-proposal:${REPLY}`,
      `task-proposal:${REPLY}`,
    ]);
    expect(assignees(opened.assigned())).toStrictEqual([ADA]);
    expect(opened.page.find('[data-proposal="task"]')?.getAttribute('href')).toBe('/task/T-31');
  });

  it('an assignment refused as stale leaves the task made and says it was not assigned', async () => {
    const because = 'This task changed since you read it.';
    const opened = await drawer({
      replies: [answered(CREATE)],
      assigns: [refused('VERSION_STALE', because)],
    });
    track(opened.page);
    await opened.ask('We need the printer booked');
    await opened.click();
    expect(opened.page.find('[data-proposal="task"]')?.getAttribute('href')).toBe('/task/T-31');
    expect(opened.page.find('[data-proposal="refusal"]')?.textContent).toContain(
      'The task was created but not assigned',
    );
  });
});
