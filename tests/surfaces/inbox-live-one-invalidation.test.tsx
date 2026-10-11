// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { mount, settle } from './mount.tsx';

// eslint-disable-next-line max-lines-per-function -- one mounted screen and its fake server
describe('SL04 live Tasks screen', () => {
  // eslint-disable-next-line max-lines-per-function -- one behavioural sequence on a mounted screen
  it('one live invalidation updates the open board and reads no inbox', async () => {
    let changed = false;
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const task = {
      id: 'task-1',
      key: 'TSK-1',
      title: 'Added by a teammate',
      state: null,
      assignee: null,
      due: null,
      // The rest of a board row as the wire carries it (MP-5-8), so the
      // Projects board can draw it.
      completedAt: null,
      revision: 1,
      rank: { number: null, score: null, calc: '' },
      stage: null,
      clientSet: false,
    };
    const fetch = ((url: string | URL) => {
      const path = String(url);
      if (path.includes('/live')) {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streams.push(controller);
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        );
      }
      if (path.endsWith('/task/board')) {
        return Promise.resolve(Response.json({ ok: true, tasks: changed ? [task] : [] }));
      }
      // The assignee editor's people (MP-5-10), none.
      if (path.endsWith('/person/list'))
        return Promise.resolve(Response.json({ ok: true, persons: [] }));
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof globalThis.fetch;
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch,
    });
    const view = await mount(
      <Projects client={client} grantKey="alpha:recipient" navigate={() => {}} />,
    );
    try {
      await settle();
      expect(view.text()).not.toContain('Added by a teammate');

      changed = true;
      for (const stream of streams) {
        stream.enqueue(new TextEncoder().encode('event: invalidate\ndata: board\n\n'));
      }
      await vi.waitFor(
        async () => {
          await settle();
          expect(view.text()).toContain('Added by a teammate');
        },
        { timeout: 500 },
      );
    } finally {
      await view.unmount();
    }
  });
});
