// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act, type ReactElement } from 'react';
import { beforeEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { TaskPanel } from '../../apps/web/src/screens/task/Panel.tsx';
import { TaskPinsProvider } from '../../apps/web/src/screens/task/task-pins-context.tsx';
import { mount, settle, type Mounted } from '../surfaces/mount.tsx';
import { task, TASK_ID } from './task-page-stub.tsx';

const OTHER = '22222222-2222-4222-8222-222222222222';
const selected = task({ rank: { number: 4, score: 504, calc: 'Derived rank 4' } });
const earlier = task({
  id: OTHER,
  key: 'Proj-Earlier',
  title: 'Earlier ranked task',
  rank: { number: 1, score: 900, calc: 'Derived rank 1' },
});
const boardRows = [earlier, selected].map((item) =>
  Object.assign({}, item, {
    actualMinutes: 0,
    estimateMinutes: null,
    pageLink: null,
    statePosition: null,
    waitReason: null,
    awaitingDecision: false,
    agent: null,
    myAgents: [],
    comments: { client: 0, mentions: 0, latest: null },
  }),
);
const accepted = (): Response =>
  Response.json({ recordId: null, revision: null, detail: { preference: 'tasks.pinned' } });

function server() {
  let persisted: readonly string[] = [];
  const saves: { readonly body: unknown; readonly answer: (response: Response) => void }[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    const path = new URL(String(url), 'http://test').pathname;
    const body: unknown = JSON.parse(String(init?.body ?? '{}'));
    if (path.endsWith('/preference/save'))
      return new Promise<Response>((resolve) => {
        saves.push({
          body,
          answer: (response) => {
            if (response.ok) {
              if (typeof body !== 'object' || body === null || !('value' in body))
                throw new Error('Missing saved pin value');
              if (!Array.isArray(body.value)) throw new Error('Invalid saved pin value');
              persisted = Array.from(body.value, (id: unknown) => {
                if (typeof id !== 'string') throw new Error('Invalid saved pin identity');
                return id;
              });
            }
            resolve(response);
          },
        });
      });
    const value = path.endsWith('/preference/read')
      ? { preferences: { 'tasks.pinned': persisted } }
      : path.endsWith('/task/board')
        ? { ok: true, viewer: null, tasks: boardRows }
        : path.endsWith('/task/read')
          ? { ok: true, task: selected }
          : path.endsWith('/person/list')
            ? { ok: true, persons: [] }
            : path.endsWith('/client/list')
              ? { ok: true, clients: [] }
              : path.endsWith('/inbox/read')
                ? { ok: true, inbox: [] }
                : path.endsWith('/inbox/count')
                  ? { ok: true, owed: 0 }
                  : null;
    return Promise.resolve(
      value === null ? new Response(null, { status: 503 }) : Response.json(value),
    );
  };
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    saves,
  };
}

function composed(client: OperationsClient, grantKey = 'alpha:owner', active = true): ReactElement {
  return (
    <TaskPinsProvider client={client} grantKey={grantKey} active={active}>
      <Projects client={client} grantKey={grantKey} navigate={() => {}} />
      <TaskPanel
        client={client}
        grantKey={grantKey}
        opening={{ taskKey: selected.key, door: 'open', tab: null }}
        onChanged={() => {}}
        onClose={() => {}}
      />
    </TaskPinsProvider>
  );
}
const order = (view: Mounted): readonly (string | null)[] =>
  view
    .all('tr[data-row]')
    .map((row) => (row instanceof HTMLElement ? (row.dataset['row'] ?? null) : null));
const pin = '[data-task-pin="panel"]';
const pressed = (view: Mounted): string | null | undefined =>
  view.host.querySelector(pin)?.getAttribute('aria-pressed');
async function answer(send: ((response: Response) => void) | undefined, response: Response) {
  expect(send).toBeTypeOf('function');
  await act(() => send?.(response));
  await settle();
}
beforeEach(() => {
  window.history.replaceState(null, '', '/projects/');
});

it('panel pin persists through the owning preference command and orders authorised board rows without changing their ranks', async () => {
  const api = server();
  const view = await mount(composed(api.client));
  await settle();
  expect(order(view)).toEqual([OTHER, TASK_ID]);
  expect(pressed(view)).toBe('false');
  expect(view.find('[data-task-pin="board"]')).toBeNull();
  await view.click(pin);
  expect(pressed(view)).toBe('true');
  expect(order(view)).toEqual([TASK_ID, OTHER]);
  expect(view.find(`tr[data-row="${TASK_ID}"] td[data-key="rank"]`)?.textContent).toBe('4');
  expect(view.find(`tr[data-row="${OTHER}"] td[data-key="rank"]`)?.textContent).toBe('1');
  expect(api.saves[0]?.body).toMatchObject({ preference: 'tasks.pinned', value: [TASK_ID] });
  await answer(api.saves[0]?.answer, accepted());
  await view.unmount();
  const reopened = await mount(composed(api.client));
  await settle();
  expect(pressed(reopened)).toBe('true');
  expect(order(reopened)).toEqual([TASK_ID, OTHER]);
  await reopened.click(pin);
  expect(order(reopened)).toEqual([OTHER, TASK_ID]);
  expect(api.saves[1]?.body).toMatchObject({ preference: 'tasks.pinned', value: [] });
  await answer(api.saves[1]?.answer, accepted());
});

it('the composed recovery retries the same unanswered pin operation and a changed owner ignores its late answer', async () => {
  const api = server();
  const view = await mount(composed(api.client));
  await settle();
  await view.click(pin);
  const sent = api.saves[0]?.body;
  await answer(api.saves[0]?.answer, new Response(null, { status: 503 }));
  expect(view.host.querySelector(pin)?.hasAttribute('disabled')).toBe(true);
  expect(view.text()).toContain('Retry pin change');
  await view.click('[data-task-panel] [data-task-pins-failure] button');
  expect(api.saves[1]?.body).toEqual(sent);
  const next = server();
  await view.render(composed(next.client, 'alpha:next-owner'));
  await settle();
  expect(pressed(view)).toBe('false');
  expect(order(view)).toEqual([OTHER, TASK_ID]);
  await answer(api.saves[1]?.answer, accepted());
  expect(pressed(view)).toBe('false');
  expect(order(view)).toEqual([OTHER, TASK_ID]);
  await view.render(composed(next.client, 'client:owner', false));
  await settle();
  expect(view.all('[data-task-pin]')).toHaveLength(0);
  expect(order(view)).toEqual([OTHER, TASK_ID]);
});
