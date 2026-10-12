// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A chat card's assignment under timing: the team read before the click, the
// create's answer before the assignment, and a retry of either.
//
// One click is one intent: its assignment goes out under the reply's own
// operation id, and every retry of it, a reload's included, must carry the
// same body, or the server refuses the second as OPERATION_ID_REUSED while
// the first stands. Each card is matched against the team as it is when that
// card is drawn, not as an earlier card found it, so a teammate who joined,
// left or was renamed since is matched as they are now. A second click while
// the first is out sends nothing more, and a create whose answer was lost is
// sent again under its own id before any assignment.
// The operations client is a recorder standing in for the network only
// (`chat-proposal-drawer.tsx`).

import { afterEach, describe, expect, it } from 'vitest';
import { NOT_ON_TEAM } from '../../apps/web/src/assistant/assignees.ts';
import {
  ADA,
  answered,
  block,
  drawer,
  ok,
  REPLY,
  refused,
  type Answer,
} from './chat-proposal-drawer.tsx';
import { settle } from './mount.tsx';
import { track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const MIA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MIA_TWO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RAJ = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
/** A second reply in the same tab, with a message id of its own. */
const LATER = '88888888-8888-4888-8888-888888888888';

const member = (personId: string, name: string) => ({ personId, name, availability: null });
const teamOf = (...people: ReturnType<typeof member>[]): Answer =>
  ok({ ok: true, you: ADA, people: [member(ADA, 'Ada Lovelace'), ...people] });

const naming = (assignee: string): string =>
  block(JSON.stringify({ action: 'create', title: 'Book the printer', assignee }));

const assignees = (sent: readonly { readonly body: Answer }[]): unknown[] =>
  sent.map((each) => (each.body['fields'] as Answer)['assignee']);

const lost: Answer = { unavailable: true, because: 'The network dropped.' };

// eslint-disable-next-line max-lines-per-function -- each timing of the card, in the page's order
describe('chat proposal assignee under retries and team changes', () => {
  it.each([
    ['a second Mia joined', 'Mia', teamOf(member(MIA, 'Mia Chen'), member(MIA_TWO, 'Mia Park'))],
    ['Mia was renamed', 'Mia Chen', teamOf(member(MIA, 'Mia Chen-Ito'))],
  ])(
    'an assignment whose answer was lost, retried after a reload once %s, sends the same body under its one operation id',
    async (_case, name, changed) => {
      const named = naming(name);
      const live = await drawer({
        replies: [answered(named)],
        team: teamOf(member(MIA, 'Mia Chen')),
        assigns: [lost],
      });
      await live.ask('Book the printer for Mia');
      expect(live.page.find('[data-proposal="assignee"]')?.textContent).toBe(
        'Assigned to Mia Chen',
      );
      await live.click();
      // The assignment may have landed: its answer never came back.
      expect(live.page.find('[data-proposal="send"]')?.textContent).toBe('Send again');
      await live.page.unmount();

      const again = await drawer({ kept: { body: named, scope: null }, team: changed });
      track(again.page);
      await again.click();

      const first = live.assigned();
      const retried = again.assigned();
      expect(first.map((each) => each.options['operationId'])).toStrictEqual([
        `task-proposal-assign:${REPLY}`,
      ]);
      expect(retried.map((each) => each.options['operationId'])).toStrictEqual([
        `task-proposal-assign:${REPLY}`,
      ]);
      // One operation id is one request: the retry must be the attempt it repeats.
      expect(retried.map((each) => each.body)).toStrictEqual(first.map((each) => each.body));
    },
  );

  it.each([
    [
      'a teammate who joined since',
      'Raj Patel',
      teamOf(member(MIA, 'Mia Chen'), member(RAJ, 'Raj Patel')),
      'Raj Patel',
      RAJ,
    ],
    ['a teammate renamed since', 'Mia Ito', teamOf(member(MIA, 'Mia Ito')), 'Mia Ito', MIA],
    ['a teammate whose membership ended since', 'Mia Chen', teamOf(), 'you', ADA],
  ])(
    'a later card naming %s is matched against the team as it is when that card is drawn',
    async (_case, name, now, shown, holder) => {
      let team = teamOf(member(MIA, 'Mia Chen'));
      const opened = await drawer({
        replies: [
          answered(block('{"action":"create","title":"Order toner"}')),
          { answered: true, messageId: LATER, body: naming(name) },
        ],
        get team() {
          return team;
        },
      });
      track(opened.page);
      await opened.ask('Order toner');
      await opened.click();
      // The team changes after the first card was drawn and before the second.
      team = now;
      await opened.ask(`And book the printer for ${name}`);
      // The later card is the last one drawn; the first is already made.
      const later = opened.page.all('[data-proposal="card"]').at(-1);
      expect(later?.querySelector('[data-proposal="assignee"]')?.textContent).toBe(
        `Assigned to ${shown}`,
      );
      const note = holder === ADA ? NOT_ON_TEAM : undefined;
      expect(later?.querySelector('[data-proposal="assignee-note"]')?.textContent).toBe(note);
      await opened.click();
      expect(assignees(opened.assigned())).toStrictEqual([ADA, holder]);
    },
  );

  it('a second click while the create is out sends one create and one assignment', async () => {
    let answer: ((value: Answer) => void) | undefined;
    const pending = new Promise<Answer>((resolve) => {
      answer = resolve;
    });
    const opened = await drawer({
      replies: [answered(naming('Mia Chen'))],
      writes: [pending],
      team: teamOf(member(MIA, 'Mia Chen')),
    });
    track(opened.page);
    await opened.ask('Book the printer for Mia');
    await opened.page.click('[data-proposal="send"]');
    await opened.page.click('[data-proposal="send"]');
    answer?.(ok({ recordId: 'new-task-id', revision: 1, detail: { key: 'T-31' } }));
    await settle();
    expect(opened.writes()).toHaveLength(1);
    expect(assignees(opened.assigned())).toStrictEqual([MIA]);
  });

  it('a create whose answer was lost sends no assignment, and Send again sends the create under its id, then the one assignment', async () => {
    const opened = await drawer({
      replies: [answered(naming('Mia Chen'))],
      writes: [lost],
      team: teamOf(member(MIA, 'Mia Chen')),
    });
    track(opened.page);
    await opened.ask('Book the printer for Mia');
    await opened.click();
    expect(opened.assigned()).toHaveLength(0);
    expect(opened.page.find('[data-proposal="send"]')?.textContent).toBe('Send again');
    await opened.click();
    expect(opened.writes().map((each) => each.options['operationId'])).toStrictEqual([
      `task-proposal:${REPLY}`,
      `task-proposal:${REPLY}`,
    ]);
    expect(assignees(opened.assigned())).toStrictEqual([MIA]);
    expect(opened.page.find('[data-proposal="task"]')?.getAttribute('href')).toBe('/task/T-31');
  });

  it('an assignment refused as stale leaves the task made and says it was not assigned', async () => {
    const because = 'This task changed since you read it.';
    const opened = await drawer({
      replies: [answered(naming('Mia Chen'))],
      assigns: [refused('VERSION_STALE', because)],
      team: teamOf(member(MIA, 'Mia Chen')),
    });
    track(opened.page);
    await opened.ask('Book the printer for Mia');
    await opened.click();
    expect(opened.page.find('[data-proposal="task"]')?.getAttribute('href')).toBe('/task/T-31');
    expect(opened.page.find('[data-proposal="refusal"]')?.textContent).toContain(
      'The task was created but not assigned',
    );
  });
});
