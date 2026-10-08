// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from '../surfaces/mount.tsx';
import { person, clientId, row } from './typed-todo-scope-support.tsx';
type RefreshTodo = Omit<ReturnType<typeof row>, 'tags'> & { tags: { id: string; name: string }[] };
function changingClient({
  people,
  clients,
  todos,
  denyTasks,
  takeHeld,
  reads,
  healthy,
}: {
  readonly people: () => readonly { personId: string; name: string }[];
  readonly clients: () => readonly { clientId: string; name: string }[];
  readonly todos: () => readonly RefreshTodo[];
  readonly denyTasks: () => boolean;
  readonly takeHeld: () => Promise<Response> | undefined;
  readonly reads: unknown[];
  readonly healthy: () => boolean;
}) {
  return new OperationsClient({
    origin: '',
    businessKey: 'synthetic',
    signedIn: true,
    fetch: (input, init) => {
      const path = String(input);
      if (path.includes('/live?') && healthy())
        return Promise.resolve(
          new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } }),
        );
      if (path.endsWith('/person/list')) {
        const held = takeHeld();
        return held ?? responseOf({ ok: true, persons: people() });
      }
      if (path.endsWith('/client/list')) return responseOf({ ok: true, clients: clients() });
      if (!path.endsWith('/task/todos')) throw new Error(`Unexpected write or read: ${path}`);
      reads.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
      return denyTasks()
        ? responseOf({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403)
        : responseOf({ ok: true, todos: todos() });
    },
  });
}
// A checked-read transport whose permission vocabulary can change without a new owner.
export function changing() {
  return new ChangingScope();
}
class ChangingScope {
  people = [{ personId: person, name: 'Noah Lee' }];
  clients = [{ clientId, name: 'Acme Physio' }];
  todos: RefreshTodo[] = [
    { ...row('Review', 'Review work', 'Review'), waitingComments: 2 },
    { ...row('Team', 'Team work'), waitingComments: 5 },
  ];
  readonly reads: unknown[] = [];
  denyTasks = false;
  healthy = false;
  heldPeople: Promise<Response> | undefined;
  readonly client = changingClient({
    people: () => this.people,
    clients: () => this.clients,
    todos: () => this.todos,
    denyTasks: () => this.denyTasks,
    takeHeld: () => {
      const held = this.heldPeople;
      this.heldPeople = undefined;
      return held;
    },
    reads: this.reads,
    healthy: () => this.healthy,
  });
  rename() {
    this.people = [{ personId: person, name: 'Current permitted name' }];
    for (const todo of this.todos)
      todo.assignee = { personId: person, name: 'Current permitted name' };
  }
  revoke() {
    this.people = [];
    this.clients = [];
    this.denyTasks = true;
  }
  holdPeople() {
    const old = this.people;
    let release: (() => void) | undefined;
    this.heldPeople = new Promise<Response>((resolve) => {
      release = () => {
        void responseOf({ ok: true, persons: old }).then(resolve);
      };
    });
    return () => {
      release?.();
    };
  }
  addUnwaiting() {
    this.todos.push({ ...row('Unwaiting', 'Unwaiting review', 'Review'), waitingComments: 0 });
  }
  revokeTasks() {
    this.denyTasks = true;
  }
  ambiguous() {
    this.people = [
      { personId: person, name: 'Noah Lee' },
      { personId: '88888888-8888-4888-8888-888888888888', name: 'Noah Lee' },
    ];
  }
}
function responseOf(value: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}
export async function key(
  view: Awaited<ReturnType<typeof mount>>,
  selector: string,
  pressed: string,
) {
  const target = view.host.querySelector(selector);
  if (target === null) throw new Error(`Missing ${selector}`);
  await act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: pressed, bubbles: true }));
  });
}
export async function refresh() {
  await act(async () => {
    window.dispatchEvent(new Event('online'));
    await Promise.resolve();
  });
  await settle();
}
