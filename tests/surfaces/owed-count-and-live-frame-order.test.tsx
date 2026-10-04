// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-promise-executor-return, require-await -- Sol's proof, kept as written */
import { act } from 'react';
import { expect, it } from 'vitest';
import { createLiveHub } from '../../apps/web/src/data/live.ts';
import { useOwedCount } from '../../apps/web/src/data/owed-count.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';

const countAnswer = (owed: number): Response =>
  new Response(JSON.stringify({ owed }), {
    headers: { 'content-type': 'application/json' },
  });

// Sol OW-079.4 criterion 5, retitled by what it proves; its body is Sol's.
it('an older inbox count cannot overwrite the latest completed read', async () => {
  const pending: ((response: Response) => void)[] = [];
  const client = new OperationsClient({
    origin: 'http://api.test',
    businessKey: 'alpha',
    signedIn: true,
    fetch: async (url) => {
      if (String(url).endsWith('/inbox/count')) {
        return await new Promise<Response>((resolve) => pending.push(resolve));
      }
      return new Response('', { status: 503 });
    },
  });
  const session = { businessKey: 'alpha', email: 'ada@example.test' };
  function Count() {
    return <output>{useOwedCount(client, session, true)}</output>;
  }
  const view = await mount(<Count />);
  try {
    expect(pending).toHaveLength(1);
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(pending).toHaveLength(2);
    await act(async () => pending[1]?.(countAnswer(2)));
    expect(view.text()).toBe('2');
    await act(async () => pending[0]?.(countAnswer(1)));
    expect(view.text()).toBe('2');
  } finally {
    await view.unmount();
    await settle();
  }
});

// Sol OW-079.5 criterion 5, retitled by what it proves; its body is Sol's.
it('a buffered closed frame from an aborted join cannot close its replacement', async () => {
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const heard: string[] = [];
  const hub = createLiveHub(
    async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller);
        },
      }),
    { visible: () => true },
  );
  const stopFirst = hub.follow('task:a', () => {});
  await settle();
  // Queue the replacement before fulfilling the old reader, so abort happens first.
  stopFirst();
  const stopSecond = hub.follow('task:a', (change) => heard.push(change));
  const stopOther = hub.follow('task:b', () => {});
  streams[0]?.enqueue(new TextEncoder().encode('event: closed\ndata: task:a\n\n'));
  try {
    await settle();
    expect(heard).toEqual([]);
  } finally {
    stopSecond();
    stopOther();
    await settle();
  }
});
