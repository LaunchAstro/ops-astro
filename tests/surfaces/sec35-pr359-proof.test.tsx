// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// SEC35's two findings on the task page's run map (PR 359), one proof each.
//
// M1: an answer read under one scope and a change to another scope batched
// into one render. The map must not draw, or hold, the old scope's graph while
// the new scope's read is pending, whichever crossing it is.
//
// L1: a task change during a live reread. `useRead` must not report the old
// task's live reread as live under the new task, not even for one commit.

import { act, useLayoutEffect, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { createLiveHub } from '../../apps/web/src/data/live.ts';
import { useRead } from '../../apps/web/src/data/use-read.ts';
import { OperationsClient, type CallResult } from '../../apps/web/src/operations/client.ts';
import { RunProgress } from '../../apps/web/src/views/run-progress.tsx';
import { EXECUTION, RECEIPT } from '../visual/made-up-data.ts';
import { tick } from './mp-6-3-fixture.tsx';
import './mount.tsx';

const clientFor = (businessKey: string, fetch: typeof globalThis.fetch) =>
  new OperationsClient({ origin: '', businessKey, signedIn: true, fetch });

/** Run `work` inside one act, so every update it makes lands in one render. */
const inAct = async (work: () => void): Promise<void> => {
  await act(async () => {
    work();
    await Promise.resolve();
  });
};

const crossings = [
  { boundary: 'business to business', business: 'beta', grantKey: 'beta:bea', taskKey: 'T-1' },
  { boundary: 'client to client', business: 'alpha', grantKey: 'alpha:ada', taskKey: 'T-2' },
  { boundary: 'person to person', business: 'alpha', grantKey: 'alpha:bea', taskKey: 'T-1' },
];

for (const crossing of crossings) {
  // eslint-disable-next-line max-lines-per-function -- one root, an answer and a crossing batched on it
  it(`SEC35 M1: ${crossing.boundary} batched with the old scope's answer never draws its graph`, async () => {
    let reads = 0;
    let release: ((response: Response) => void) | undefined;
    const original = clientFor('alpha', (input) => {
      if (String(input).endsWith('/task/receipt')) return Promise.resolve(Response.json(RECEIPT));
      reads += 1;
      if (reads === 1) return Promise.resolve(Response.json(EXECUTION));
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const replacement = clientFor(crossing.business, () => new Promise<Response>(() => {}));
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await inAct(() => {
        root.render(
          <RunProgress client={original} grantKey="alpha:ada" taskKey="T-1" readOf={1} />,
        );
      });
      await tick();
      expect(host.querySelector('[data-execution-map="bound"]')).not.toBeNull();
      await inAct(() => {
        root.render(
          <RunProgress client={original} grantKey="alpha:ada" taskKey="T-1" readOf={2} />,
        );
      });
      expect(release).toBeDefined();
      // Alpha's answer and the scope change land in one render.
      await act(async () => {
        release?.(Response.json(EXECUTION));
        for (let n = 0; n < 4; n += 1) {
          // eslint-disable-next-line no-await-in-loop -- let the answer reach the read
          await new Promise((resolve) => {
            setTimeout(resolve, 0);
          });
        }
        root.render(
          <RunProgress
            client={replacement}
            grantKey={crossing.grantKey}
            taskKey={crossing.taskKey}
            readOf={3}
          />,
        );
      });
      expect(host.querySelectorAll('[data-execution-map]')).toHaveLength(0);
    } finally {
      await inAct(() => {
        root.unmount();
      });
      host.remove();
    }
  });
}

interface Task {
  readonly id: string;
}

// eslint-disable-next-line max-lines-per-function -- one probe, a live reread and a task change on it
it('SEC35 L1: a task change during a live reread is never reported live under the new task', async () => {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const hub = createLiveHub(
    async () =>
      await Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
      ),
    { visible: () => true },
  );
  const settled = new Set<string>();
  const committed: { readonly taskKey: string; readonly live: boolean }[] = [];
  function Probe(props: { readonly taskKey: string }): ReactElement {
    const { state, live } = useRead<Task>({
      grantKey: 'alpha:ada',
      run: async () =>
        settled.has(props.taskKey)
          ? await new Promise<CallResult<Task>>(() => {})
          : { ok: true, value: { id: props.taskKey } },
      deps: [props.taskKey],
      live: { hub, topic: (task) => `task:${task.id}` },
    });
    useLayoutEffect(() => {
      committed.push({ taskKey: props.taskKey, live });
    });
    return <p data-outcome={state.outcome}>{props.taskKey}</p>;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await inAct(() => {
      root.render(<Probe taskKey="T-1" />);
    });
    await tick();
    settled.add('T-1');
    settled.add('T-2');
    expect(stream).toBeDefined();
    await inAct(() => {
      stream?.enqueue(new TextEncoder().encode('event: invalidate\ndata: task:T-1\n\n'));
    });
    await tick();
    expect(committed.at(-1)).toEqual({ taskKey: 'T-1', live: true });
    await inAct(() => {
      root.render(<Probe taskKey="T-2" />);
    });
    expect(committed.filter((each) => each.taskKey === 'T-2' && each.live)).toEqual([]);
  } finally {
    await inAct(() => {
      root.unmount();
    });
    host.remove();
  }
});
