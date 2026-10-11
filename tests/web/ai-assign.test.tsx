// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Assign to AI on the dock task panel and the task page: the control offers
// the agents the reader may direct (`myAgents`), by name; choosing one sends
// `task.assign` with `agent`, and the task's agent shows by name with its
// owner. With no agent to offer, no select is drawn. The rules are
// tests/commands/task-assign-ai*.

import { afterEach, describe, expect, it } from 'vitest';
import { TASK_ID, found, tick } from './task-page-stub.tsx';
import { page, unmountAll } from './perspective-support.tsx';
import { panel, serving } from './panel-fields-support.tsx';

afterEach(unmountAll);

const MINE = [
  { agentId: 'd-mine-1', name: 'Reply drafter' },
  { agentId: 'd-mine-2', name: 'Inbox triage' },
];
const HELD = {
  agent: {
    agentId: 'd-mine-1',
    name: 'Reply drafter',
    owner: { personId: 'p-ada', name: 'Ada' },
    live: true,
    run: null,
  },
};

const options = (view: { readonly all: (s: string) => readonly Element[] }, select: string) =>
  view.all(`${select} option`).map((option) => (option as HTMLOptionElement).value);

describe('Assign to AI: the dock task panel', () => {
  it('the control lists the agents I may direct', async () => {
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

  it('with no agent to offer, no control is drawn', async () => {
    const view = await panel(serving({ myAgents: [] }).client);
    expect(view.find('#panel-assign-ai')).toBeNull();
    expect(view.find('[data-assign-ai]')).toBeNull();
  });

  it('the assignee shows as the agent by name, with its owner', async () => {
    const view = await panel(serving({ ...HELD, myAgents: MINE }).client);
    expect(view.find('[data-agent-assignee]')?.textContent).toBe('AI: Reply drafter, owned by Ada');
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

  it('the task page shows the agent assignee by name, with its owner', async () => {
    const view = await page('Proj-Verity-Pacing', found({ ...HELD, myAgents: [] }));
    expect(view.find('[data-agent-assignee]')?.textContent).toBe('AI: Reply drafter, owned by Ada');
  });

  it('Assign to AI is locked while the title or due date is unsaved, as assigning is', async () => {
    const view = await page('Proj-Verity-Pacing', found({ myAgents: MINE }));
    const locked = (): boolean | undefined =>
      view.find('#page-assign-ai')?.hasAttribute('disabled');
    expect(locked()).toBe(false);
    await view.type('#task-title', 'Budget pacing fix, renamed');
    // The unsaved bar is up, the same lock the assignee and the state buttons are under.
    expect(view.find('[data-draft-resolve="choice"]')).not.toBeNull();
    expect(locked()).toBe(true);
  });
});
