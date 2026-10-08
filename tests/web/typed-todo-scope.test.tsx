// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TodosScreen } from '../../apps/web/src/screens/todos/Todos.tsx';
import {
  person,
  clientId,
  row,
  transport,
  heldTransport,
  deniedVocabulary,
} from './typed-todo-scope-support.tsx';
import { mount, settle } from '../surfaces/mount.tsx';

it('multiword person and client choose the intersected server scope before local filters', async () => {
  const t = transport();
  const view = await mount(<TodosScreen client={t.client} grantKey="synthetic:owner" />);
  await settle();
  expect(view.text()).toContain('My work');
  await view.type('#todos-search', 'person:"Noah Lee" client:"Acme Physio"');
  await settle();
  expect(t.reads.at(-1)).toEqual({ person, client: clientId });
  expect(view.text()).toContain('Team work');
  expect(view.text()).not.toContain('My work');
  expect(view.find('[data-todos-reading]')?.textContent).toContain('Noah Lee');
  await view.type('#todos-search', 'person:"Noah Lee" client:"Acme Physio" route:review');
  expect(view.find('[data-todo-row="Team-3"]')).not.toBeNull();
  expect(view.find('[data-todo-row="Team-2"]')).toBeNull();
});
it('an unknown typed identity blocks rows and Drop scope restores own read', async () => {
  const t = transport();
  const view = await mount(<TodosScreen client={t.client} grantKey="synthetic:owner" />);
  await settle();
  await view.type('#todos-search', 'person:"Not permitted"');
  expect(view.all('[data-todo-row]')).toHaveLength(0);
  expect(view.text()).toContain('Unknown person');
  await view.click('[data-todos="clear"]');
  expect(view.text()).toContain('My work');
});

it('ambiguous names offer only permitted identities and no read until a choice', async () => {
  const chosen = '88888888-8888-4888-8888-888888888888';
  const requests: unknown[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const path = String(input);
    const answer = path.endsWith('/person/list')
      ? {
          ok: true,
          persons: [
            { personId: person, name: 'Noah Lee' },
            { personId: chosen, name: 'Noah Lee' },
          ],
        }
      : path.endsWith('/client/list')
        ? { ok: true, clients: [] }
        : {
            ok: true,
            todos: [
              { ...row('Chosen', 'Chosen work'), assignee: { personId: chosen, name: 'Noah Lee' } },
            ],
          };
    if (path.endsWith('/task/todos'))
      requests.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
    return Promise.resolve(
      new Response(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } }),
    );
  };
  const client = new OperationsClient({
    origin: '',
    businessKey: 'synthetic',
    signedIn: true,
    fetch,
  });
  const view = await mount(<TodosScreen client={client} grantKey="synthetic:owner" />);
  await settle();
  await view.type('#todos-search', 'person:"Noah Lee"');
  expect(view.all('[data-todos-identity]')).toHaveLength(2);
  expect(view.all('[data-todo-row]')).toHaveLength(0);
  expect(requests).toEqual([{}]);
  await view.click(`[data-todos-identity="${chosen}"]`);
  await settle();
  expect(requests.at(-1)).toEqual({ person: chosen });
  expect(view.text()).toContain('Chosen work');
});

it('scope changes clear rows and an outstanding previous response cannot land', async () => {
  const { client, release, personReads } = heldTransport();
  const view = await mount(<TodosScreen client={client} grantKey="synthetic:owner" />);
  await settle();
  await view.type('#todos-search', 'person:"Noah Lee"');
  expect(personReads()).toBe(1);
  expect(view.text()).not.toContain('Own work');
  await view.click('[data-todos="clear"]');
  await settle();
  expect(view.text()).toContain('Own work');
  release(
    new Response(JSON.stringify({ ok: true, todos: [row('Old', 'Old scope canary')] }), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  await settle();
  expect(view.text()).not.toContain('Old scope canary');
  expect(view.text()).toContain('Own work');
});
it('dropping a typed person keeps the original client door narrowing', async () => {
  const t = transport();
  const view = await mount(
    <TodosScreen
      client={t.client}
      grantKey="synthetic:owner"
      scope={{ kind: 'client', clientId, name: 'Acme Physio' }}
    />,
  );
  await settle();
  await view.type('#todos-search', 'person:"Noah Lee"');
  await settle();
  expect(t.reads.at(-1)).toEqual({ person, client: clientId });
  await view.click('[data-todos="clear"]');
  await settle();
  expect(t.reads.at(-1)).toEqual({ client: clientId });
});

it('reserved due words keep their meaning even when a permitted person has that name', async () => {
  const reads: unknown[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const path = String(input);
    const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    if (path.endsWith('/task/todos')) reads.push(body);
    const answer = path.endsWith('/person/list')
      ? { ok: true, persons: [{ personId: person, name: 'Today' }] }
      : path.endsWith('/client/list')
        ? { ok: true, clients: [] }
        : { ok: true, todos: [row('Due', 'Undated work')] };
    return Promise.resolve(
      new Response(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } }),
    );
  };
  const client = new OperationsClient({
    origin: '',
    businessKey: 'synthetic',
    signedIn: true,
    fetch,
  });
  const view = await mount(<TodosScreen client={client} grantKey="synthetic:owner" />);
  await settle();
  await view.type('#todos-search', 'today');
  await settle();
  expect(reads).toEqual([{}]);
  expect(view.find('[data-todos-reading]')?.textContent).toContain('due today');
  await view.type('#todos-search', 'person:Today');
  await settle();
  expect(reads.at(-1)).toEqual({ person });
});

it('a new owner never draws carried identity names or rows from the previous scope', async () => {
  const t = transport();
  const scope = { kind: 'client' as const, clientId, name: 'Old private client name' };
  const view = await mount(
    <TodosScreen client={t.client} grantKey="synthetic:old-owner" scope={scope} />,
  );
  await settle();
  expect(view.text()).toContain('Team work');
  expect(view.text()).not.toContain('Old private client name');
  const denied = new OperationsClient({
    origin: '',
    businessKey: 'synthetic',
    signedIn: true,
    fetch: deniedVocabulary,
  });
  await view.render(<TodosScreen client={denied} grantKey="synthetic:new-owner" scope={scope} />);
  await settle();
  expect(view.text()).not.toContain('Acme Physio');
  expect(view.text()).not.toContain('Old private client name');
  expect(view.all('[data-todo-row]')).toHaveLength(0);
});

it('a client route door carries its real family, and contradictory routes cannot widen the list', async () => {
  const t = transport();
  const view = await mount(
    <TodosScreen
      client={t.client}
      grantKey="synthetic:owner"
      scope={{ kind: 'client', clientId, name: 'Acme Physio', family: 'Review' }}
    />,
  );
  await settle();
  expect(view.find('[data-todo-row="Team-3"]')).not.toBeNull();
  expect(view.find('[data-todo-row="Team-1"]')).toBeNull();
  await view.type('#todos-search', 'route:team');
  expect(view.all('[data-todo-row]')).toHaveLength(0);
});

it('the compact board door carries admitted intersected scope and complete filters', async () => {
  const t = transport();
  const view = await mount(<TodosScreen client={t.client} grantKey="synthetic:owner" />);
  await settle();
  await view.type(
    '#todos-search',
    'person:"Noah Lee" client:"Acme Physio" route:review due:today p1 tag:urgent work',
  );
  await settle();
  const door = view.find('[data-todos="board"]');
  const address = new URL(door?.getAttribute('href') ?? '', 'http://here');
  expect(address.searchParams.get('pool')).toBe('aggregate');
  expect(address.searchParams.get('person')).toBe(person);
  expect(address.searchParams.get('client')).toBe(clientId);
  expect(address.searchParams.get('route')).toBe('Review');
  expect(JSON.parse(address.searchParams.get('filters') ?? '[]')).toEqual([
    { kind: 'due', value: 'today' },
    { kind: 'priority', value: 1 },
    { kind: 'tag', value: 'urgent' },
    { kind: 'words', value: 'work' },
  ]);
});
it('the compact board door distinguishes aggregate own work and blocks unresolved scope', async () => {
  const t = transport();
  const view = await mount(<TodosScreen client={t.client} grantKey="synthetic:owner" />);
  await settle();
  const address = new URL(
    view.find('[data-todos="board"]')?.getAttribute('href') ?? '',
    'http://here',
  );
  expect(address.searchParams.get('pool')).toBe('aggregate');
  expect(address.searchParams.get('scope')).toBe('own');
  await view.type('#todos-search', 'person:"Not permitted"');
  expect(view.find('[data-todos="board"]')?.getAttribute('aria-disabled')).toBe('true');
  expect(view.find('[data-todos="board"]')?.hasAttribute('href')).toBe(false);
});
