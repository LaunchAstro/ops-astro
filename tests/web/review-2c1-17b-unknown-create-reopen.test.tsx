// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Review proof REVIEW-2C1-17b (REVIEW-BATCH #305): a Create whose answer nobody
// knows keeps its operation id only in the draft panel's state. Close then
// unmounts the panel and loses it; New task restores the kept draft and Create
// mints a new id, so the server's replay cannot answer it and the task (and
// its logged time) can be created twice.
//
// Driven through the dock panel's own hook, against a server that drops the
// first top-level create on the network and answers the second.

import { type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type { Session } from '../../apps/web/src/session/token.ts';
import { useDockPanel } from '../../apps/web/src/screens/task/DockPanel.tsx';
import { task, tick } from './task-page-stub.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { NEW_ID, NEW_KEY, store } from './draft-support.tsx';

afterEach(unmountAll);

const ADA: Session = { businessKey: 'alpha', email: 'ada@example.test' };

/** A server whose first top-level `task.create` fails on the network; every read names its task by key. */
function server() {
  const creates: string[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const where = String(url);
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    if (where.endsWith('/task/read')) {
      const key = String(body['recordId']);
      return Promise.resolve(json({ ok: true, task: task({ key, title: `Title of ${key}` }) }));
    }
    if (where.endsWith('/task/create') && body['parentId'] === undefined) {
      creates.push(String(body['operationId']));
      if (creates.length === 1) return Promise.reject(new TypeError('network down'));
      return Promise.resolve(json({ recordId: NEW_ID, revision: 1, detail: { key: NEW_KEY } }));
    }
    if (where.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
    if (where.endsWith('/task/queue')) {
      return Promise.resolve(json({ ok: true, queue: [], alerts: [], outages: [] }));
    }
    return Promise.resolve(json({ ok: false }));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { client, creates };
}

function Dock(props: {
  readonly client: OperationsClient;
  readonly session: Session | null;
  readonly grantKey: string;
  readonly storage: Storage;
}): ReactElement {
  const dock = useDockPanel(props);
  return (
    <main>
      <button
        type="button"
        data-door="Proj-First"
        onClick={() => {
          dock.host.open('Proj-First', 'open');
        }}
      >
        Proj-First
      </button>
      {dock.panel}
    </main>
  );
}

type View = Awaited<ReturnType<typeof mount>>;

const settle = async (): Promise<void> => {
  for (let round = 0; round < 12; round += 1) {
    // eslint-disable-next-line no-await-in-loop -- one settle at a time
    await tick();
  }
};

/** Open the task through its door, then New task from the panel's head. */
async function newTask(view: View): Promise<void> {
  await view.click('[data-door="Proj-First"]');
  await tick();
  await view.click('[data-task-panel] [data-panel-head="new"]');
  await tick();
}

describe('REVIEW-2C1-17b: Create after an unknown answer, Close and New task again', () => {
  it('REVIEW-2C1-17b: the reopened draft’s Create carries the same operation id as the unknown one', async () => {
    const api = server();
    const storage = store();
    const view = await mount(
      <Dock client={api.client} session={ADA} grantKey="alpha:ada:0" storage={storage} />,
    );
    await newTask(view);
    await view.type('#panel-draft-name', 'New brief');
    await view.click('[data-draft="create"]');
    await settle();
    expect(api.creates).toHaveLength(1);
    // The answer is unknown: Create is free again, and so is Close.
    expect(view.find('[data-draft-refusal]')).not.toBeNull();
    expect((view.find('[data-draft="close"]') as HTMLButtonElement).disabled).toBe(false);
    await view.click('[data-draft="close"]');
    await tick();
    expect(view.find('[data-draft-panel]')).toBeNull();
    await newTask(view);
    expect((view.find('#panel-draft-name') as HTMLInputElement).value).toBe('New brief');
    await view.click('[data-draft="create"]');
    await settle();
    expect(api.creates).toHaveLength(2);
    expect(
      api.creates[1],
      'the second /task/create after an unknown answer must replay the first operationId',
    ).toBe(api.creates[0]);
  });
});
