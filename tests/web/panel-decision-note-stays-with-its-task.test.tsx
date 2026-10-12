// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The task panel holds a decision refused for want of the grant above its
// read, for one task under one grant. Decisions settle on their own time, so
// two races are attacked here. An older decision that succeeds after a newer
// one was refused does not reopen the gate. A decision that settles after
// the panel moved to another task, or the tab to another reader, closes
// nothing there, even where the gate carries the same id.

import type { ReactElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { StepUpContext } from '../../apps/web/src/records/use-money-command.ts';
import { TaskPanel } from '../../apps/web/src/screens/task/Panel.tsx';
import { DIGEST, lineage, version } from '../surfaces/mp-6-1-agent-fixtures.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { KEY, PANE } from './task-panel-agent-support.tsx';
import { task, tick } from './task-page-stub.tsx';

afterEach(unmountAll);

const ignore = (): void => {
  /* The case reads nothing from this call. */
};

const GATE = { id: 'g-1', state: 'pending', round: 1, expiresAt: null, expired: false };
const OTHER = 'Proj-Other-Task';
const APPROVE = `${PANE} [data-gate-action="approve"]`;
const refused = (): Response =>
  json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403);

type Answer = (response: Response) => void;

/** The reads every case answers the same way. */
function steady(where: string): Response | null {
  if (where.endsWith('/person/list')) return json({ ok: true, persons: [] });
  if (where.endsWith('/task/queue')) return json({ ok: true, queue: [], alerts: [], outages: [] });
  if (where.endsWith('/preference/read')) return json({ ok: true, preferences: {} });
  if (where.endsWith('/client/list')) return json({ ok: true, clients: [] });
  if (where.endsWith('/task/board')) return json({ ok: true, tasks: [] });
  if (/\/live(\/task\/|\?|$)/u.test(where)) return new Response(null, { status: 404 });
  return null;
}

/** Tasks with the same pending gate; each decision waits until the case answers it. */
function server() {
  let reads: 'ok' | 'unavailable' = 'ok';
  const decisions: Answer[] = [];
  const over = {
    proposals: [
      lineage({
        versions: [version({ versionId: 'v-1', gate: { ...GATE, payloadDigest: DIGEST } })],
      }),
    ],
  };
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const where = String(url);
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    if (where.endsWith('/task/read')) {
      const key = String(body['recordId']);
      return Promise.resolve(
        reads === 'ok'
          ? json({ ok: true, task: task({ ...over, key }) })
          : new Response(null, { status: 503 }),
      );
    }
    if (where.endsWith('/task/decide')) {
      return new Promise<Response>((resolve) => {
        decisions.push(resolve);
      });
    }
    return Promise.resolve(steady(where) ?? json({ ok: false }));
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    decisions,
    answer: (next: 'ok' | 'unavailable') => {
      reads = next;
    },
    settle: async (at: number, response: Response) => {
      decisions[at]?.(response);
      await tick();
    },
  };
}

const panel = (
  client: OperationsClient,
  changes: number,
  taskKey = KEY,
  grantKey = 'alpha:member',
): ReactElement => (
  <StepUpContext.Provider
    value={() => Promise.resolve({ ok: false, because: 'Not here.' } as const)}
  >
    <TaskPanel
      client={client}
      grantKey={grantKey}
      opening={{ taskKey, door: 'open', tab: null }}
      changes={changes}
      onChanged={ignore}
      onClose={ignore}
    />
  </StepUpContext.Provider>
);

async function agentSide(api: ReturnType<typeof server>) {
  const view = await mount(panel(api.client, 0));
  await tick();
  await view.click('#panel-perspective-tab-agent');
  await tick();
  return view;
}

it('an older decision that succeeds after a newer one was refused leaves the gate closed', async () => {
  const api = server();
  const view = await agentSide(api);
  await view.click(APPROVE);
  await tick();
  expect(api.decisions).toHaveLength(1);
  // A reread that answers unavailable drops the pane and its busy control, so
  // the person can decide again while the first decision is still out.
  api.answer('unavailable');
  await view.render(panel(api.client, 1));
  await tick();
  api.answer('ok');
  await view.render(panel(api.client, 2));
  await tick();
  await view.click(APPROVE);
  await tick();
  expect(api.decisions).toHaveLength(2);
  await api.settle(1, refused());
  expect(view.find(`${PANE} [data-gate="closed"]`)).not.toBeNull();

  await api.settle(0, json({ ok: true, recordId: null, revision: null, detail: {} }));
  expect(view.find(`${APPROVE}`)).toBeNull();
  expect(view.find(`${PANE} [data-gate="closed"]`)).not.toBeNull();
});

it.each([
  { boundary: 'another task', next: (client: OperationsClient) => panel(client, 1, OTHER) },
  {
    boundary: 'another reader',
    next: (client: OperationsClient) => panel(client, 1, KEY, 'alpha:other'),
  },
])(
  'a refusal that settles after the panel moved to $boundary closes nothing there',
  async ({ next }) => {
    const api = server();
    const view = await agentSide(api);
    await view.click(APPROVE);
    await tick();
    expect(api.decisions).toHaveLength(1);
    await view.render(next(api.client));
    await tick();
    if (view.find(`${APPROVE}`) === null) await view.click('#panel-perspective-tab-agent');
    await tick();
    expect(view.find(`${APPROVE}`)).not.toBeNull();

    await api.settle(0, refused());
    expect(view.find(`${APPROVE}`)).not.toBeNull();
    expect(view.find(`${PANE} [data-gate="closed"]`)).toBeNull();
  },
);
