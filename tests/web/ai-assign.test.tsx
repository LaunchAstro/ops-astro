// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Assign to AI on the dock task panel and the task page: the control offers
// only the reader's own agents that reach the task (`myAgents`, which the
// server fills with nothing else), choosing one sends `task.assign` with
// `agent`, and the task's agent shows with the person accountable for it.
// With no agent of the reader's own, nothing is drawn: no hint that anyone
// else's exists. The rules are tests/commands/task-assign-ai*.

import { afterEach, describe, expect, it } from 'vitest';
import { TASK_ID, found, page, tick } from './task-page-stub.tsx';
import { unmountAll } from './perspective-support.tsx';
import { panel, serving } from './panel-fields-support.tsx';

afterEach(unmountAll);

const MINE = [
  { delegationId: 'd-mine-1', purpose: 'draft_replies' },
  { delegationId: 'd-mine-2', purpose: 'triage_inbox' },
];
const HELD = {
  agent: {
    delegationId: 'd-mine-1',
    purpose: 'draft_replies',
    accountable: { personId: 'p-ada', name: 'Ada' },
    live: true,
  },
};

const options = (view: { readonly all: (s: string) => readonly Element[] }, select: string) =>
  view.all(`${select} option`).map((option) => (option as HTMLOptionElement).value);

describe('Assign to AI: the dock task panel', () => {
  it('the control lists only my agents that reach the task', async () => {
    const view = await panel(serving({ myAgents: MINE }).client);
    expect(options(view, '#panel-assign-ai')).toStrictEqual(['', 'd-mine-1', 'd-mine-2']);
  });

  it('choosing one sends task.assign with the agent, at the read revision', async () => {
    const server = serving({ myAgents: MINE });
    const changes = { count: 0 };
    const view = await panel(server.client, { changed: () => (changes.count += 1) });
    await view.choose('#panel-assign-ai', 'd-mine-2');
    await tick();
    expect(
      server.sent.map((one) => [one.to, one.body['recordId'], one.body['fields']]),
    ).toStrictEqual([['/task/assign', TASK_ID, { agent: 'd-mine-2' }]]);
    expect(changes.count).toBe(1);
  });

  it('others’ agents are not shown: with none of my own, no control and no hint', async () => {
    const view = await panel(serving({ myAgents: [] }).client);
    expect(view.find('#panel-assign-ai')).toBeNull();
    expect(view.find('[data-assign-ai]')).toBeNull();
  });

  it('the assignee shows as the agent, with the person accountable for it', async () => {
    const view = await panel(serving({ ...HELD, myAgents: MINE }).client);
    expect(view.find('[data-agent-assignee]')?.textContent).toBe(
      'Assigned to AI: draft_replies, for Ada',
    );
  });
});

describe('Assign to AI: the task page', () => {
  it('the task page offers the same control, only my agents', async () => {
    const view = await page('Proj-Verity-Pacing', found({ myAgents: MINE }));
    expect(options(view, '#page-assign-ai')).toStrictEqual(['', 'd-mine-1', 'd-mine-2']);
  });

  it('with none of my own agents the task page draws no control', async () => {
    const view = await page('Proj-Verity-Pacing', found({ myAgents: [] }));
    expect(view.find('#page-assign-ai')).toBeNull();
  });

  it('the task page shows the agent assignee with its accountable person', async () => {
    const view = await page('Proj-Verity-Pacing', found({ ...HELD, myAgents: [] }));
    expect(view.find('[data-agent-assignee]')?.textContent).toBe(
      'Assigned to AI: draft_replies, for Ada',
    );
  });
});
