// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// AW-04 start from the pane (moved from MP-6-1, TR-API-5): the Agent pane's
// "Start a new attempt" is wired to the plan accept. A new attempt is a new
// plan, and a plan is accepted in the drawer, so the pane's button asks the
// drawer to plan a new attempt at the task; the drawer opens on that task with
// the question drafted and sends nothing until the person does. The card's
// one click (tests/surfaces/aw-04-drawer-plan.test.tsx) is the accept.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { act, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  askDrawer,
  newAttemptAsk,
  useAgentDrawer,
  useAsks,
} from '../../apps/web/src/assistant/asks.ts';
import type { AskEntry } from '../../apps/web/src/assistant/chats.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import { lineage, pane, unmountAll as unmountPanes } from './mp-6-1-agent-fixtures.tsx';
import { mount, settle } from './mount.tsx';
import { press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);
afterEach(unmountPanes);

const TASK = { id: '88888888-8888-4888-8888-888888888888', title: 'Spring brief', clientId: null };

const input = (page: { find: (s: string) => Element | null }): HTMLTextAreaElement => {
  const found = page.find('[data-assistant="input"]');
  if (!(found instanceof HTMLTextAreaElement) && !(found instanceof HTMLInputElement)) {
    throw new TypeError('no drawer input');
  }
  return found as HTMLTextAreaElement;
};

/** The dock's half: opens the drawer on the asked entry, as App does. */
function Dock(props: { readonly client: OperationsClient }): ReactElement | null {
  const [open, setOpen] = useAgentDrawer();
  return open ? (
    <AssistantView
      client={props.client}
      route="agency:task-detail"
      here="/task/T-12"
      entry={null}
      onClose={() => {
        setOpen(false);
      }}
    />
  ) : null;
}

describe('AW-04 start from the pane', () => {
  it('AW-04 start from the pane: on an ended attempt the pane’s Start a new attempt is live and asks for a new plan', async () => {
    const onStartAttempt = vi.fn();
    const page = await pane({ lineages: [lineage({ state: 'rejected' })], onStartAttempt });
    expect(page.find('[data-agent="start"]')?.hasAttribute('disabled')).toBe(false);
    expect(page.find('[data-agent="start-unavailable"]')).toBeNull();
    await page.click('[data-agent="start"]');
    expect(onStartAttempt).toHaveBeenCalledTimes(1);
  });

  it('AW-04 start from the pane: the ask opens the drawer on the task with the new attempt’s question drafted, and nothing is sent until the person sends it', async () => {
    const sent: { name: string; body: unknown }[] = [];
    const client = {
      mutate: (name: string, body: unknown) => {
        sent.push({ name, body });
        return Promise.resolve({
          ok: true,
          value: { recordId: '', revision: 0, detail: { conversationId: 'c-1' } },
        });
      },
    } as unknown as OperationsClient;
    const page = track(await mount(<Dock client={client} />));
    expect(page.find('[data-assistant="input"]')).toBeNull();

    const entry: AskEntry = newAttemptAsk(TASK);
    askDrawer(entry);
    await settle();
    expect(input(page).value).toBe('Plan a new attempt at Spring brief.');
    expect(input(page).getAttribute('aria-label')).toBe('Ask the agent about Spring brief');
    expect(sent).toStrictEqual([]);

    await press(page, '[data-assistant="input"]', 'Enter');
    await settle();
    expect(sent.map((each) => each.name)).toStrictEqual(['conversation.start']);
    expect(sent[0]?.body).toMatchObject({
      body: 'Plan a new attempt at Spring brief.',
      scope: { kind: 'task', id: TASK.id },
    });
  });
});

/** The drawer's half, recording each ask it takes. */
function Heard(props: { readonly into: AskEntry[] }): null {
  useAsks((entry) => {
    props.into.push(entry);
  });
  return null;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The task page over a stubbed `task.read` whose task belongs to `clientId`, an ended attempt on it. */
async function taskPage(clientId: string | null, into: AskEntry[]) {
  const task = {
    id: TASK.id,
    key: 'T-12',
    title: TASK.title,
    clientId,
    description: null,
    state: null,
    assignee: null,
    due: null,
    priority: null,
    completedAt: null,
    revision: 3,
    history: [],
    comments: [],
    proposals: [lineage({ state: 'rejected' })],
  };
  const answer = (at: string): Response => {
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/task/read')) return json({ ok: true, task });
    return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
  };
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: ((url: string | URL) =>
      Promise.resolve(answer(String(url)))) as unknown as typeof globalThis.fetch,
    newOperationId: () => 'operation-1',
  });
  const page = track(
    await mount(
      <>
        <Heard into={into} />
        <TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="T-12" />
      </>,
    ),
  );
  await act(async () => {
    for (let n = 0; n < 3; n += 1) {
      // eslint-disable-next-line no-await-in-loop -- let each read settle in turn
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
  return page;
}

describe('SL12-19-F2 the pane asks with the task’s client', () => {
  it('a client’s task: Start a new attempt asks the drawer with the client id task.read returned', async () => {
    const asks: AskEntry[] = [];
    const page = await taskPage('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', asks);
    await page.click('[data-agent="start"]');
    expect(asks.map((ask) => ask.scope.task)).toStrictEqual([
      { id: TASK.id, title: TASK.title, clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    ]);
  });

  it('an internal task: the ask names no client', async () => {
    const asks: AskEntry[] = [];
    const page = await taskPage(null, asks);
    await page.click('[data-agent="start"]');
    expect(asks.map((ask) => ask.scope.task)).toStrictEqual([{ ...TASK }]);
  });
});
