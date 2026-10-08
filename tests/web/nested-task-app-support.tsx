// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactElement } from 'react';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { mount } from '../surfaces/mount.tsx';
import { store } from './draft-support.tsx';
import { task } from './task-page-stub.tsx';

export const ID = '11111111-1111-4111-8111-111111111111';
export interface Sent {
  readonly path: string;
  readonly body: Record<string, unknown>;
}
export function nestedTab(): Storage {
  const storage = store();
  storage.setItem(
    'ops-astro.session',
    JSON.stringify({ businessKey: 'alpha', email: 'nested@example.test' }),
  );
  return storage;
}
function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}
function defaultReply(request: Sent): Response {
  switch (request.path) {
    case '/preference/read':
      return response({ ok: true, preferences: {} });
    case '/task/board':
      return response({ ok: true, tasks: [] });
    case '/client/list':
      return response({ ok: true, clients: [] });
    case '/person/list':
      return response({ ok: true, persons: [] });
    case '/task/queue':
      return response({ ok: true, queue: [], alerts: [], outages: [] });
    case '/task/read':
      return response({
        ok: true,
        task: task({
          id: ID,
          key: 'Created-strip',
          time: { entries: [], running: null, totalMinutes: 0 },
        }),
      });
    case '/task/create':
      return response({ recordId: ID, revision: 1, detail: { key: 'Created-strip' } });
    case '/task/set_category':
      return response({ recordId: ID, revision: 2, detail: {} });
    default:
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'READ_UNAVAILABLE',
          message: 'Unavailable in this isolated fixture',
        }),
        { status: 503 },
      );
  }
}
export async function nestedAppHost(
  input: {
    readonly storage?: Storage;
    readonly path?: string;
    readonly reply?: (sent: Sent) => Promise<Response> | undefined;
  } = {},
) {
  const storage = input.storage ?? nestedTab();
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    const request = {
      path: String(url).replace(/^.*?(\/[a-z]+\/[a-z_]+)$/u, '$1'),
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >,
    };
    sent.push(request);
    const reply = input.reply?.(request);
    if (reply !== undefined) return reply;
    return Promise.resolve(defaultReply(request));
  };
  function Entry(): ReactElement {
    const [path, navigate] = useState(input.path ?? '/projects/');
    return (
      <App
        path={path}
        navigate={navigate}
        sessions={new SessionStore(storage)}
        gotrueUrl="http://gotrue.test"
        apiOrigin=""
        fetch={fetch}
        storage={storage}
        panels={{
          todos: { label: 'Projects', ariaLabel: 'Projects', route: 'agency:projects-board' },
        }}
      />
    );
  }
  const element = <Entry />;
  const view = await mount(element);
  return { view, storage, sent, element };
}
