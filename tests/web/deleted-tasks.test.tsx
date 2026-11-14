// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// #2346: the Tasks page's Deleted tab lists `task.bin`'s rows, restores one
// through `task.restore` with the row's batch and reads the list again; a
// reader the server refuses sees its words and no row; a Restore whose answer
// was lost is sent again under the same operation id.

import { afterEach, expect, it } from 'vitest';
import { DeletedTasks } from '../../apps/web/src/screens/projects/DeletedTasks.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { json, mount, unmountAll } from './perspective-support.tsx';

interface Sent {
  readonly command: string;
  readonly body: Readonly<Record<string, unknown>>;
}

type Reply = { readonly body: unknown; readonly status: number } | 'lost';

const ROW = {
  batchId: '0b9f6c1e-1d2a-4e5b-9c3d-7a8b9c0d1e2f',
  taskId: '5d0c2b1a-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
  key: 'T-41',
  title: 'Draft the spring newsletter',
  deletedAt: '2026-11-14T03:00:00.000Z',
  deletedBy: 'Ada Admin',
};

const BIN = (rows: readonly unknown[]) => ({
  body: { ok: true, bin: rows, more: false },
  status: 200,
});
const RESTORED = {
  body: { ok: true, recordId: null, revision: null, detail: { batchId: ROW.batchId, restored: 1 } },
  status: 200,
};

/** A server answering each request with the next reply for its command. */
function server(replies: Readonly<Record<string, Reply[]>>) {
  const sent: Sent[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const command = at.slice(at.lastIndexOf('/b/alpha/') + 9).replace('/', '.');
    sent.push({
      command,
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'],
    });
    const reply = replies[command]?.shift();
    if (reply === undefined) throw new Error(`no reply left for ${command}`);
    if (reply === 'lost') return Promise.reject(new TypeError('network down'));
    return Promise.resolve(json(reply.body, reply.status));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { client, sent };
}

const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) {
    // eslint-disable-next-line no-await-in-loop -- each turn lets one answer land
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};

afterEach(unmountAll);

it('lists a deleted task with who and when, restores it by its batch and reads the list again', async () => {
  const { client, sent } = server({
    'task.bin': [BIN([ROW]), BIN([])],
    'task.restore': [RESTORED],
  });
  const view = await mount(<DeletedTasks client={client} grantKey="alpha:ada" />);
  await settled();
  expect(view.text()).toContain('T-41 Draft the spring newsletter');
  expect(view.text()).toContain('Ada Admin');

  await view.click('[data-act="restore"] button');
  await settled();
  const restores = sent.filter((each) => each.command === 'task.restore');
  expect(restores).toHaveLength(1);
  expect(restores[0]?.body['batchId']).toBe(ROW.batchId);
  expect(sent.filter((each) => each.command === 'task.bin')).toHaveLength(2);
  expect(view.text()).not.toContain('Draft the spring newsletter');
  expect(view.text()).toContain('No deleted tasks.');
});

it('shows a reader the server refuses its words and no row or Restore', async () => {
  const { client } = server({
    'task.bin': [
      {
        body: {
          refused: true,
          code: 'SCOPE_NOT_GRANTED',
          names: [],
          fixes: ['no live grant covers it', 'ask a holder who may delegate'],
        },
        status: 403,
      },
    ],
  });
  const view = await mount(<DeletedTasks client={client} grantKey="alpha:mia" />);
  await settled();
  expect(view.find('[data-outcome="denied"]')).not.toBeNull();
  expect(view.find('[data-act="restore"]')).toBeNull();
});

it('sends a Restore whose answer was lost again under the same operation id', async () => {
  const { client, sent } = server({
    'task.bin': [BIN([ROW]), BIN([])],
    'task.restore': ['lost', RESTORED],
  });
  const view = await mount(<DeletedTasks client={client} grantKey="alpha:ada" />);
  await settled();
  await view.click('[data-act="restore"] button');
  await settled();
  expect(view.find('[data-restore-refused]')).not.toBeNull();
  await view.click('[data-act="restore"] button');
  await settled();
  const ids = sent
    .filter((each) => each.command === 'task.restore')
    .map((each) => each.body['operationId']);
  expect(ids).toHaveLength(2);
  expect(typeof ids[0]).toBe('string');
  expect(ids[1]).toBe(ids[0]);
});
