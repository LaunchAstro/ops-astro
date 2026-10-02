// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C4 on the page header (CS-1.1, SH-22): the task page tells the header how
// fresh it is, and the header draws the kit's freshness marker from it. The
// marker is an indicator only; `freshnessOf` decides its state
// (`c4-freshness.test.ts`), and this suite proves what the page feeds it: the
// last good read, reads failing, the stream down, the browser offline, a
// refusal (no marker at all) and the page closing (the marker goes with it).

import { afterEach, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { PageFreshnessProvider, StripFreshness } from '../../apps/web/src/views/freshness.tsx';
import { mount, type Mounted } from './mount.tsx';
import { json, until } from './c2-presence-support.tsx';

const TASK = '22222222-2222-4222-8222-222222222222';
const task = {
  id: TASK,
  key: 'TSK-2',
  title: 'Fresh',
  description: null,
  state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 1,
  history: [],
  comments: [],
};
const refusal = { refused: true, code: 'NOT_FOUND', names: [], fixes: ['Check the address.'] };
const encoder = new TextEncoder();

/** The task read and the live stream, each switchable by the case. */
function server() {
  const api = {
    read: 'ok' as 'ok' | 'fails' | 'refused',
    live: true,
    reads: 0,
    send: (_event: string) => {},
  };
  const answer = (url: string | URL): Response => {
    const path = new URL(String(url), 'http://api.test').pathname;
    if (path.endsWith('/task/read')) {
      api.reads += 1;
      if (api.read === 'fails') throw new TypeError('network down');
      return api.read === 'refused' ? json(refusal, 404) : json({ ok: true, task });
    }
    if (path.endsWith('/live')) {
      if (!api.live) return json(refusal, 404);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          api.send = (event) =>
            controller.enqueue(encoder.encode(`event: ${event}\ndata: task:${TASK}\n\n`));
        },
      });
      return new Response(body, { status: 200 });
    }
    return json(refusal, 404);
  };
  // A throw becomes a rejected fetch, as a network failure does.
  const fetch = ((url: string | URL) =>
    Promise.resolve().then(() => answer(url))) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { api, client };
}

let shown: Mounted | undefined;
afterEach(async () => {
  await shown?.unmount();
  shown = undefined;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
});

const header = (client: OperationsClient, open = true, grantKey = 't:g') => (
  <PageFreshnessProvider>
    <header className="topbar">
      <StripFreshness />
    </header>
    {open ? <TaskDetailScreen client={client} grantKey={grantKey} taskKey="TSK-2" /> : null}
  </PageFreshnessProvider>
);

const marker = (page: Mounted): string =>
  page.find('.topbar [role="status"].fresh')?.textContent ?? '';

it('C4 marker never pressed: the task page puts the kit’s marker in the header, live, with no control', async () => {
  const { client } = server();
  shown = await mount(header(client));
  await until('the marker says live', () => marker(shown!) === 'Updated just now');
  const row = shown.find('.topbar .freshrow');
  expect(row?.querySelector('.fresh--live .fresh__live')).not.toBeNull();
  // An indicator: nothing in it can be pressed or focused.
  expect(row?.querySelectorAll('button, a, input, [tabindex], [onclick]')).toHaveLength(0);
  expect(shown.find('.topbar')?.querySelectorAll('button')).toHaveLength(0);
});

it('C4 marker: the stream down says catching up with the last read', async () => {
  const { api, client } = server();
  api.live = false;
  shown = await mount(header(client));
  await until('catching up', () => /^Reconnecting · last read \d\d:\d\d$/u.test(marker(shown!)));
  expect(shown.find('.topbar .fresh--catching-up')).not.toBeNull();
});

it('C4 marker: a re-read that fails says catching up; the browser offline says offline', async () => {
  const { api, client } = server();
  shown = await mount(header(client));
  await until('live first', () => marker(shown!) === 'Updated just now');

  api.read = 'fails';
  api.send('invalidate');
  await until('the failed re-read is heard', () => api.reads === 2);
  await until('catching up', () => marker(shown!).startsWith('Reconnecting · last read '));

  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
  window.dispatchEvent(new Event('offline'));
  await until('offline', () => /^Offline · showing data from \d\d:\d\d$/u.test(marker(shown!)));

  api.read = 'ok';
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
  window.dispatchEvent(new Event('online'));
  api.send('invalidate');
  await until('live again', () => marker(shown!) === 'Updated just now');
});

it('C4 marker: a refused page claims nothing, and a closed page takes its marker with it', async () => {
  const { api, client } = server();
  shown = await mount(header(client));
  await until('live first', () => marker(shown!) === 'Updated just now');

  api.read = 'refused';
  api.send('invalidate');
  await until('the page draws its denied state', () => api.reads === 2 && marker(shown!) === '');
  expect(shown.find('.topbar .freshrow')).toBeNull();
  // A re-read after the refusal does not bring back the old read's time.
  api.read = 'fails';
  api.send('invalidate');
  await until('the next re-read is heard', () => api.reads === 3);
  expect(shown.find('.topbar .freshrow')).toBeNull();

  const again = server();
  // Another reader: a new grant is a new read.
  await shown.render(header(again.client, true, 't2:g'));
  await until('a fresh page is live', () => marker(shown!) === 'Updated just now');
  await shown.render(header(again.client, false, 't2:g'));
  expect(shown.find('.topbar .freshrow')).toBeNull();
});

it('C4 marker: one marker in the header; the tab’s offline word only while no page gives one', async () => {
  const offline = { state: 'offline', lastRead: '09:00' } as const;
  const { client } = server();
  shown = await mount(
    <PageFreshnessProvider>
      <header className="topbar">
        <StripFreshness fallback={offline} />
      </header>
    </PageFreshnessProvider>,
  );
  expect(marker(shown)).toBe('Offline · showing data from 09:00');
  await shown.render(
    <PageFreshnessProvider>
      <header className="topbar">
        <StripFreshness fallback={offline} />
      </header>
      <TaskDetailScreen client={client} grantKey="t:g" taskKey="TSK-2" />
    </PageFreshnessProvider>,
  );
  await until('the page’s own marker', () => marker(shown!) === 'Updated just now');
  expect(shown.all('.topbar .fresh')).toHaveLength(1);
});
