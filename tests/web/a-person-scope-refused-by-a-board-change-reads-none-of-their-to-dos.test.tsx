// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// A typed person scope whose vocabulary is refused by a board change's
// refresh draws none of that person's to-dos and reads none again: the
// refused vocabulary blocks the scope on its own, without withdrawing the
// whole list.
import { act } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TodosScreen } from '../../apps/web/src/screens/todos/Todos.tsx';
import { mount, settle } from '../surfaces/mount.tsx';
import { key } from './typed-todo-refresh-support.tsx';
import { person, row } from './typed-todo-scope-support.tsx';

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function world() {
  const state = {
    revoked: false,
    reads: [] as Record<string, unknown>[],
    controller: undefined as ReadableStreamDefaultController<Uint8Array> | undefined,
  };
  const scoped = [row('Team-1', 'Noah’s work')];
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
        return Promise.resolve(
          state.revoked
            ? json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403)
            : json({ ok: true, persons: [{ personId: person, name: 'Noah Lee' }] }),
        );
      if (path.endsWith('/client/list')) return Promise.resolve(json({ ok: true, clients: [] }));
      if (!path.endsWith('/task/todos')) throw new Error(`Unexpected: ${path}`);
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >;
      state.reads.push(body);
      const todos = 'person' in body ? scoped : [row('Own-1', 'My work')];
      return Promise.resolve(json({ ok: true, todos }));
    },
  });
  return { state, client };
}

it('a person scope refused by a board change draws and reads none of their to-dos', async () => {
  const { state, client } = world();
  const view = await mount(<TodosScreen client={client} grantKey="synthetic:reader" />);
  try {
    await settle();
    await view.type('#todos-search', 'person:"Noah Lee"');
    await key(view, '#todos-search', 'Enter');
    await settle();
    expect(view.find('[data-todo-row="Team-1"]')).not.toBeNull();
    const before = state.reads.length;
    state.revoked = true;
    await act(async () => {
      state.controller?.enqueue(new TextEncoder().encode('event: invalidate\ndata: board\n\n'));
      await Promise.resolve();
    });
    await settle();
    expect(view.find('[data-todo-row="Team-1"]')).toBeNull();
    expect(view.find('[data-todos-empty]')).not.toBeNull();
    expect(state.reads.slice(before).filter((body) => 'person' in body)).toEqual([]);
  } finally {
    await view.unmount();
  }
});
