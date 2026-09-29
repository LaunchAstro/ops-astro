// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// C36, a conversation's own address (CS-7.38): `/agent/:conversation`
// resolves through the route registry to the screen that reads the
// conversation by the id in the address, draws its transcript while the body
// lives and only its wrap-up once the body has purged, and is reached from
// the drawer's tab. The operations client is a recorder for the network only;
// the read itself, its refusals and the three crossings run on the real
// routes in `tests/api/c36-address.test.ts` and `c36-isolation.test.ts`.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationReadResult } from '../../packages/core-wire/src/index.ts';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import { drawScreen } from '../../apps/web/src/screen-registry.tsx';
import { gateOf, matchRoute, pathTo, ROUTES } from '../../apps/web/src/routes.ts';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';
import { press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const ID = '33333333-3333-4333-8333-333333333333';
const TASK = '44444444-4444-4444-8444-444444444444';

const LIVE: ConversationReadResult = {
  ok: true,
  conversation: {
    id: ID,
    address: `/agent/${ID}`,
    title: 'Supplier quote',
    subject: 'Fix the booking form',
    scope: { kind: 'task', id: TASK },
    page: null,
    createdAt: '2026-09-20T01:00:00.000Z',
    lastActivityAt: '2026-09-20T01:05:00.000Z',
    bodyPurgedAt: null,
  },
  messages: [
    {
      id: 'm1',
      role: 'person',
      body: 'What did the supplier quote?',
      createdAt: '2026-09-20T01:00:00.000Z',
    },
    {
      id: 'm2',
      role: 'agent',
      body: '<b>Four hundred</b> dollars',
      createdAt: '2026-09-20T01:05:00.000Z',
    },
  ],
  wrapUp: null,
  wrapUpHistory: [],
};

const PURGED: ConversationReadResult = {
  ...LIVE,
  conversation: { ...LIVE.conversation, bodyPurgedAt: '2026-09-28T01:05:00.000Z' },
  messages: null,
  wrapUp: {
    version: 1,
    writtenAt: '2026-09-21T01:05:00.000Z',
    writtenBy: { operation: 'conversation.wrap_up', codeRevision: 'c36test' },
    definitionVersion: null,
    request: { quotation: 'What did the supplier quote?' },
    items: [
      {
        key: 'tasks_created',
        fact: 'One task created',
        pointers: [
          { kind: 'task', id: TASK, address: `/task/${TASK}`, state: 'done' },
          { kind: 'task', id: 'hostile', address: 'javascript:alert(1)' },
          { kind: 'task', id: 'elsewhere', address: '//evil.example/task' },
        ],
      },
      { key: 'cost', fact: 'No priced model call recorded', pointers: [] },
    ],
    leftOpen: [],
    leftOpenText: 'nothing left open',
  },
  wrapUpHistory: [{ version: 1, writtenAt: '2026-09-21T01:05:00.000Z' }],
};

interface Asked {
  readonly name: string;
  readonly body: Readonly<Record<string, unknown>>;
}

function reader(answer: unknown): { readonly client: OperationsClient; readonly asked: Asked[] } {
  const asked: Asked[] = [];
  const client = {
    read: (name: string, body: Readonly<Record<string, unknown>>) => {
      asked.push({ name, body });
      return Promise.resolve(answer);
    },
    mutate: (name: string, body: Readonly<Record<string, unknown>>) => {
      asked.push({ name, body });
      return Promise.resolve({
        ok: true,
        value: { recordId: '', revision: 0, detail: { conversationId: ID } },
      });
    },
  } as unknown as OperationsClient;
  return { client, asked };
}

async function address(path: string, answer: unknown) {
  const match = matchRoute(path);
  if (match === null || match.id !== 'agency:agent-conversation') {
    throw new Error(`${path} is not a conversation's address`);
  }
  const { client, asked } = reader(answer);
  const page = track(
    await mount(drawScreen(match, { client, grantKey: 'g', notice: null, storage: null })),
  );
  await settle();
  return { page, asked };
}

const refusal = (code: string, fix: string): unknown => ({
  ok: false,
  refused: true,
  code,
  names: [],
  fixes: [fix],
});

describe('C36 conversation address', () => {
  it('the address is a registered route, needs a session, and is spelt by the registry', () => {
    const match = matchRoute(`/agent/${ID}`);
    expect(match?.id).toBe('agency:agent-conversation');
    expect(match?.params).toStrictEqual({ conversation: ID });
    expect(pathTo('agency:agent-conversation', { conversation: ID })).toBe(`/agent/${ID}`);
    expect(ROUTES['agency:agent-conversation']).toMatchObject({ authenticated: true, rail: false });
    expect(gateOf(matchRoute(`/agent/${ID}`), false).kind).toBe('sign-in');
  });

  it('opened in a new tab, the same conversation opens: read by the id in the address, its transcript drawn as text', async () => {
    const { page, asked } = await address(`/agent/${ID}`, LIVE);
    expect(asked).toStrictEqual([{ name: 'conversation.read', body: { conversationId: ID } }]);
    expect(page.find('[data-conversation="title"]')?.textContent).toBe('Supplier quote');
    const said = page.all('[data-conversation="message"]').map((each) => each.textContent);
    expect(said).toStrictEqual(['What did the supplier quote?', '<b>Four hundred</b> dollars']);
    expect(page.find('b')).toBeNull();
    expect(page.find('[data-conversation="wrap-up"]')).toBeNull();
  });

  it('after the body purges, the address shows the wrap-up with working links, never a transcript', async () => {
    const { page } = await address(`/agent/${ID}`, PURGED);
    expect(page.find('[data-conversation="transcript"]')).toBeNull();
    expect(page.all('[data-conversation="message"]')).toHaveLength(0);
    const wrap = page.find('[data-conversation="wrap-up"]');
    expect(wrap).not.toBeNull();
    expect(page.find('[data-conversation="request"]')?.textContent).toBe(
      'What did the supplier quote?',
    );
    expect(page.text()).toContain('One task created');
    expect(page.text()).toContain('nothing left open');
    const links = page
      .all('[data-conversation="wrap-up"] a')
      .map((each) => each.getAttribute('href'));
    expect(links).toStrictEqual([`/task/${TASK}`]);
    // A pointer to anywhere but this product is named, never linked.
    expect(page.text()).toContain('javascript:alert(1)');
  });

  it('reachable from the navigation: a started tab links to its address, one not started does not', async () => {
    const { client } = reader(LIVE);
    const page = track(
      await mount(
        <AssistantView
          client={client}
          route="agency:settings"
          here="/settings"
          entry={null}
          onClose={() => {}}
        />,
      ),
    );
    expect(page.find('[data-assistant="address"]')).toBeNull();
    await page.type('[data-assistant="input"]', 'What does this setting do?');
    await press(page, '[data-assistant="input"]', 'Enter');
    await settle();
    expect(page.find('[data-assistant="address"]')?.getAttribute('href')).toBe(`/agent/${ID}`);
  });
});

describe('C36 address refusals', () => {
  it('another business, or a made-up address: the same refusal drawn, naming nothing of the conversation', async () => {
    const answer = refusal('NOT_FOUND', 'No such conversation.');
    const foreign = await address(`/agent/${ID}`, answer);
    const madeUp = await address('/agent/55555555-5555-4555-8555-555555555555', answer);
    expect(foreign.page.find('[data-outcome="denied"]')).not.toBeNull();
    expect(foreign.page.text()).toBe(madeUp.page.text());
    expect(foreign.page.text()).not.toContain(ID);
  });

  it('a teammate without the read-any grant: refused with the reason and nothing else', async () => {
    const { page } = await address(
      `/agent/${ID}`,
      refusal('SCOPE_NOT_GRANTED', 'Only the person who held this conversation can open it.'),
    );
    expect(page.find('[data-outcome="denied"]')).not.toBeNull();
    expect(page.text()).toContain('Only the person who held this conversation can open it.');
    for (const withheld of [
      'Supplier quote',
      'Fix the booking form',
      'What did the supplier quote?',
    ]) {
      expect(page.text()).not.toContain(withheld);
    }
    expect(page.find('[data-conversation="title"]')).toBeNull();
  });
});
