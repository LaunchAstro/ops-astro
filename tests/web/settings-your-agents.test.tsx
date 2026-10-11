// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings General ▸ Your AI agents (Assign to AI): the person's own agents,
// read with `agent.mine`; Make my agent sends `agent.create` with the name
// typed, Rename sends `agent.rename` for that agent, each then reads the list
// again, and a refusal is shown in the server's words. The server's rules are
// tests/commands/agent-make.test.ts.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { AgentsGroup } from '../../apps/web/src/screens/settings/agents.tsx';
import { mount, type Mounted } from '../surfaces/mount.tsx';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const tick = async (): Promise<void> => {
  await act(async () => {
    for (let round = 0; round < 4; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- let each answer land
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
};

function server(refuse?: { readonly code: string; readonly fixes: readonly string[] }) {
  const sent: { readonly at: string; readonly body: Record<string, unknown> }[] = [];
  const agents = [{ agentId: 'a-penny', name: 'Penny' }];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    sent.push({ at, body });
    if (at.endsWith('/agent/mine')) return Promise.resolve(json({ ok: true, agents }));
    if (refuse !== undefined) {
      return Promise.resolve(json({ refused: true, names: ['name'], ...refuse }, 422));
    }
    if (at.endsWith('/agent/create')) agents.push({ agentId: 'a-new', name: String(body['name']) });
    return Promise.resolve(json({ ok: true, recordId: null, detail: { agentId: 'a-new' } }));
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const group = (fetch: typeof globalThis.fetch) => (
  <AgentsGroup
    client={new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch })}
    grantKey="alpha:ada"
  />
);

const writes = (api: ReturnType<typeof server>) =>
  api.sent.filter((call) => !call.at.endsWith('/agent/mine'));

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

it('lists my agents by name, and Make my agent sends the name typed and reads the list again', async () => {
  const api = server();
  mounted = await mount(group(api.fetch));
  await tick();
  expect((mounted.find('#agent-name-a-penny') as HTMLInputElement | null)?.value).toBe('Penny');
  await mounted.type('#agent-new-name', '  Reply drafter ');
  await mounted.click('[data-agent-new] button');
  await tick();
  expect(
    writes(api).map((call) => [call.at.split('/').slice(-2).join('/'), call.body['name']]),
  ).toEqual([['agent/create', 'Reply drafter']]);
  expect(api.sent.filter((call) => call.at.endsWith('/agent/mine'))).toHaveLength(2);
  expect(mounted.find('[data-agents-outcome="done"]')?.textContent).toBe(
    'Made your agent Reply drafter.',
  );
  expect((mounted.find('#agent-name-a-new') as HTMLInputElement | null)?.value).toBe(
    'Reply drafter',
  );
});

it('Rename sends agent.rename for that agent, and is closed until the name changes', async () => {
  const api = server();
  mounted = await mount(group(api.fetch));
  await tick();
  const rename = mounted.find('[data-agent="a-penny"] button') as HTMLButtonElement | null;
  expect(rename?.disabled).toBe(true);
  await mounted.type('#agent-name-a-penny', 'Penny the drafter');
  await mounted.click('[data-agent="a-penny"] button');
  await tick();
  expect(writes(api).map((call) => call.body)).toMatchObject([
    { agentId: 'a-penny', name: 'Penny the drafter' },
  ]);
});

it('a refusal is shown in the server’s words, and the list stays', async () => {
  const api = server({
    code: 'FIELD_VALUE_INVALID',
    fixes: ['Name the agent in 1 to 60 characters.'],
  });
  mounted = await mount(group(api.fetch));
  await tick();
  await mounted.type('#agent-new-name', 'Another');
  await mounted.click('[data-agent-new] button');
  await tick();
  expect(mounted.find('[data-agents-outcome="refused"]')?.textContent).toContain(
    'Name the agent in 1 to 60 characters.',
  );
  expect(mounted.find('#agent-name-a-penny')).not.toBeNull();
});

it('a retry after a lost answer resends the same operation id and makes one agent', async () => {
  const api = server();
  const made = new Set<unknown>();
  const losing = ((url: string | URL, init?: RequestInit) => {
    if (!String(url).endsWith('/agent/create')) return api.fetch(url, init);
    const operationId = (JSON.parse(String(init?.body)) as Record<string, unknown>)['operationId'];
    if (made.has(operationId)) {
      api.sent.push({ at: String(url), body: { operationId } });
      return Promise.resolve(json({ ok: true, recordId: null, detail: { agentId: 'a-new' } }));
    }
    made.add(operationId);
    return api.fetch(url, init).then(() => {
      throw new TypeError('connection reset');
    });
  }) as typeof globalThis.fetch;
  mounted = await mount(group(losing));
  await tick();
  await mounted.type('#agent-new-name', 'Reply drafter');
  await mounted.click('[data-agent-new] button');
  await tick();
  expect(mounted.find('[data-agents-outcome="refused"]')).not.toBeNull();
  await mounted.click('[data-agent-new] button');
  await tick();
  const ids = writes(api).map((call) => call.body['operationId']);
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(1);
  expect(mounted.all('[data-agent]').map((row) => (row as HTMLElement).dataset['agent'])).toEqual([
    'a-penny',
    'a-new',
  ]);
});

it('a changed name after a lost answer is a new attempt with a new operation id', async () => {
  const api = server();
  const ids: unknown[] = [];
  const losing = ((url: string | URL, init?: RequestInit) => {
    if (!String(url).endsWith('/agent/create')) return api.fetch(url, init);
    ids.push((JSON.parse(String(init?.body)) as Record<string, unknown>)['operationId']);
    return Promise.reject(new TypeError('connection reset'));
  }) as typeof globalThis.fetch;
  mounted = await mount(group(losing));
  await tick();
  await mounted.type('#agent-new-name', 'Reply drafter');
  await mounted.click('[data-agent-new] button');
  await tick();
  await mounted.type('#agent-new-name', 'Invoice chaser');
  await mounted.click('[data-agent-new] button');
  await tick();
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
});
