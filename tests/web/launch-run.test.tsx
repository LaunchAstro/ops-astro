// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Launch from the task, in the dock task panel: under the agent holding the
// task, Launch sends `task.launch` at the read revision; an open run shows as
// waiting for the runner instead; a client's task says it cannot go to an AI
// agent. The rules are tests/commands/task-launch*.

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import type { InternalTaskDetail as Task } from '../../packages/core-wire/src/index.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { LaunchRun } from '../../apps/web/src/screens/task/LaunchRun.tsx';
import { mount } from '../surfaces/mount.tsx';
import { TASK_ID, task, tick } from './task-page-stub.tsx';
import { unmountAll } from './perspective-support.tsx';
import { panel, serving } from './panel-fields-support.tsx';

afterEach(unmountAll);

const held = (run: unknown) => ({
  agent: {
    agentId: 'a-1',
    name: 'Reply drafter',
    owner: { personId: 'p-ada', name: 'Ada' },
    live: run !== null,
    run,
  },
  myAgents: [],
});

describe('Launch from the task', () => {
  it('Launch sends task.launch for the task at the read revision', async () => {
    const server = serving(held(null));
    const changes = { count: 0 };
    const view = await panel(server.client, { changed: () => (changes.count += 1) });
    expect(view.find('[data-launch-run]')?.textContent).toBe('Launch Reply drafter');
    await view.click('[data-launch-run]');
    await tick();
    const sent = server.sent.filter((one) => one.to === '/task/launch');
    expect(sent.map((one) => one.body['recordId'])).toStrictEqual([TASK_ID]);
    expect(typeof sent[0]?.body['expectedRevision']).toBe('number');
    expect(changes.count).toBe(1);
  });

  it('an open run shows as waiting for the runner, with no Launch', async () => {
    const view = await panel(
      serving(held({ state: 'waiting', launchedAt: '2026-10-11T09:00:00Z' })).client,
    );
    expect(view.find('[data-launch-run]')).toBeNull();
    expect(view.find('[data-run-state]')?.textContent).toBe('Run waiting for the runner');
  });

  it("a client's task says it cannot go to an AI agent", async () => {
    const view = await panel(
      serving({ ...held(null), client: { clientId: 'c-1', name: 'Acme' } }).client,
    );
    expect(view.find('[data-launch-run]')).toBeNull();
    expect(view.text()).toContain('Only internal tasks go to an AI agent for now.');
  });
});

describe('Launch retried after a lost answer', () => {
  it('resends the same operation id and the revision first sent, though the task has moved on', async () => {
    const sent: Record<string, unknown>[] = [];
    const fetch = ((_url: string | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sent.length === 1
        ? Promise.reject(new TypeError('connection reset'))
        : Promise.resolve(
            new Response(JSON.stringify({ ok: true, recordId: TASK_ID }), {
              headers: { 'content-type': 'application/json' },
            }),
          );
    }) as typeof globalThis.fetch;
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch,
    });
    const at = (revision: number) => (
      <LaunchRun
        client={client}
        task={task({ ...held(null), revision }) as unknown as Task}
        busy={false}
        onChanged={() => {}}
      />
    );
    const view = await mount(at(1));
    onTestFinished(() => view.unmount());
    await view.click('[data-launch-run]');
    await tick();
    await view.render(at(2));
    await view.click('[data-launch-run]');
    await tick();
    expect(sent.map((body) => [body['operationId'], body['expectedRevision']])).toStrictEqual([
      [sent[0]?.['operationId'], 1],
      [sent[0]?.['operationId'], 1],
    ]);
  });
});
