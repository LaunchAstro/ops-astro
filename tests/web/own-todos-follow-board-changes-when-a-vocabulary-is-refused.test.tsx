// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// A reader holding task:read but not person:read (or client:read) still has
// their own to-dos follow a board change on the live stream. The refused
// vocabulary only disables the typed person or client scope.
import { act } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TodosScreen } from '../../apps/web/src/screens/todos/Todos.tsx';
import { mount, settle } from '../surfaces/mount.tsx';
import { key } from './typed-todo-refresh-support.tsx';
import { row } from './typed-todo-scope-support.tsx';

const json = (value: unknown, status = 200): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );

type Refused = 'nothing' | 'person.list' | 'client.list';
const refusal = () => json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403);

function world(refused: Refused) {
  const state = {
    todos: [row('First', 'First own task')],
    reads: [] as unknown[],
    controller: undefined as ReadableStreamDefaultController<Uint8Array> | undefined,
  };
  const client = new OperationsClient({
    origin: '',
    businessKey: 'synthetic',
    signedIn: true,
    fetch: (input, init) => {
      const path = String(input);
      if (path.includes('/live?'))
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start: (c) => {
                state.controller = c;
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        );
      if (path.endsWith('/person/list'))
        return refused === 'person.list' ? refusal() : json({ ok: true, persons: [] });
      if (path.endsWith('/client/list'))
        return refused === 'client.list' ? refusal() : json({ ok: true, clients: [] });
      if (!path.endsWith('/task/todos')) throw new Error(`Unexpected: ${path}`);
      state.reads.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
      return json({ ok: true, todos: state.todos });
    },
  });
  return { state, client };
}

async function boardChange(state: ReturnType<typeof world>['state']) {
  await act(async () => {
    state.controller?.enqueue(new TextEncoder().encode('event: invalidate\ndata: board\n\n'));
    await Promise.resolve();
  });
  await settle();
}

for (const refused of ['nothing', 'person.list', 'client.list'] as const)
  it(`own to-dos follow a board change (${refused} refused)`, async () => {
    const { state, client } = world(refused);
    const view = await mount(<TodosScreen client={client} grantKey="synthetic:reader" />);
    await settle();
    expect(view.find('[data-todo-row="First"]')).not.toBeNull();
    state.todos = [...state.todos, row('Second', 'Second own task')];
    await boardChange(state);
    expect(view.find('[data-todo-row="Second"]')).not.toBeNull();
  });

for (const [refused, kind] of [
  ['person.list', 'person'],
  ['client.list', 'client'],
] as const)
  it(`a refused ${refused} keeps the typed ${kind} scope disabled`, async () => {
    const { state, client } = world(refused);
    const view = await mount(<TodosScreen client={client} grantKey="synthetic:reader" />);
    await settle();
    await view.type('#todos-search', `${kind}:"Noah Lee"`);
    await key(view, '#todos-search', 'Enter');
    await settle();
    expect(view.all('[data-todo-row]')).toHaveLength(0);
    expect(
      state.reads.some((body) => typeof body === 'object' && body !== null && kind in body),
    ).toBe(false);
  });
