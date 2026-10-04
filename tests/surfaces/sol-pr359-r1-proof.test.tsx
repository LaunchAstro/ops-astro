// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only

import { act } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { ExecutionMap } from '../../packages/ui/src/index.ts';
import { RunProgress } from '../../apps/web/src/views/run-progress.tsx';
import { madeUpAnswer } from '../visual/made-up-api.ts';
import { EXECUTION, RECEIPT } from '../visual/made-up-data.ts';
import { mount } from './mount.tsx';
import { gate, run, step, tick } from './mp-6-3-fixture.tsx';

const clientFor = (businessKey: string, fetch: typeof globalThis.fetch) =>
  new OperationsClient({ origin: '', businessKey, signedIn: true, fetch });

const success = () => Response.json(EXECUTION);
const refused = () =>
  Response.json(
    { refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] },
    { status: 403 },
  );

for (const boundary of ['business to business', 'client to client', 'person to person']) {
  it(`Sol proof, criterion 2: ${boundary} never inherits the preceding execution map while its own read is pending`, async () => {
    const original = clientFor('alpha', (input) =>
      Promise.resolve(String(input).endsWith('/task/receipt') ? Response.json(RECEIPT) : success()),
    );
    const replacement = clientFor(
      boundary === 'business to business' ? 'beta' : 'alpha',
      () => new Promise<Response>(() => {}),
    );
    const page = await mount(
      <RunProgress client={original} grantKey="alpha:ada" taskKey="T-1" readOf={1} />,
    );
    try {
      await tick();
      expect(page.find('[data-execution-map="bound"]')).not.toBeNull();
      await page.render(
        <RunProgress
          client={replacement}
          grantKey={
            boundary === 'business to business'
              ? 'beta:bea'
              : boundary === 'person to person'
                ? 'alpha:bea'
                : 'alpha:ada'
          }
          taskKey={boundary === 'client to client' ? 'T-2' : 'T-1'}
          readOf={2}
        />,
      );
      expect(page.find('[data-run-progress]')?.getAttribute('data-outcome')).toBe('loading');
      expect(page.all('[data-execution-map]')).toHaveLength(0);
    } finally {
      await page.unmount();
    }
  });
}

it('Sol proof, criterion 3: a denied execution read discards its graph before a subsequent reread', async () => {
  let phase = 0;
  const client = clientFor('alpha', (input) =>
    String(input).endsWith('/task/receipt')
      ? Promise.resolve(Response.json(RECEIPT))
      : phase === 0
        ? Promise.resolve(success())
        : phase === 1
          ? Promise.resolve(refused())
          : new Promise<Response>(() => {}),
  );
  const draw = (readOf: number) => (
    <RunProgress client={client} grantKey="alpha:ada" taskKey="T-1" readOf={readOf} />
  );
  const page = await mount(draw(0));
  try {
    await tick();
    expect(page.find('[data-execution-map="bound"]')).not.toBeNull();
    phase = 1;
    await page.render(draw(1));
    await tick();
    expect(page.find('[data-run="denied"]')).not.toBeNull();
    expect(page.all('[data-execution-map]')).toHaveLength(0);
    phase = 2;
    await page.render(draw(2));
    expect(page.find('[data-run-progress]')?.getAttribute('data-outcome')).toBe('loading');
    expect(page.all('[data-execution-map]')).toHaveLength(0);
  } finally {
    await page.unmount();
  }
});

it('Sol proof, criterion 5: a completed execution read does not ask for approval from an older pending gate snapshot', async () => {
  // task.read finishes before another caller approves and completes the run;
  // task.execution then finishes with the newer observed layer.
  const page = await mount(
    <ExecutionMap
      graph={{
        plan: 'bound',
        steps: [step('draft', [], ['r-1']), step('send', ['draft'])],
        nodes: [run('r-1', 'settled', { outcome: 'completed' })],
      }}
      gates={[gate('r-1', 'pending')]}
    />,
  );
  try {
    expect(page.find('[data-tg-node="draft"] .spill')?.textContent).toBe('Done');
    expect(page.find('[data-tg-node="send"] [data-map="dependency"]')?.textContent).toBe(
      'After draft',
    );
    expect(page.find('[data-tg-node="draft"] .tg__nout')?.textContent).toBe('OUT Done');
  } finally {
    await page.unmount();
  }
});

it('Sol proof, criterion 1: the real task page keeps its execution map and selected card through a live task reread', async () => {
  let reread = false;
  let release: ((response: Response) => void) | undefined;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let topic: string | null = null;
  const fetch: typeof globalThis.fetch = (input) => {
    const url = new URL(String(input), 'http://made.up');
    const path = url.pathname;
    if (path.endsWith('/live')) {
      topic = url.searchParams.get('topic');
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    }
    if (path.endsWith('/task/execution')) return Promise.resolve(success());
    if (path.endsWith('/task/read') && reread)
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    const answer = madeUpAnswer(path);
    return Promise.resolve(
      answer !== undefined && 'json' in answer
        ? Response.json(answer.json, { status: answer.status })
        : new Response(null, { status: 503 }),
    );
  };
  const client = clientFor('alpha', fetch);
  const page = await mount(<TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="T-1" />);
  try {
    await tick();
    await page.click('[data-tg-node="send"]');
    expect(page.find('[data-tg-node="send"]')?.getAttribute('aria-pressed')).toBe('true');
    reread = true;
    expect(stream).toBeDefined();
    expect(topic).not.toBeNull();
    await act(async () => {
      stream?.enqueue(new TextEncoder().encode(`event: invalidate\ndata: ${topic}\n\n`));
    });
    await tick();
    expect(release).toBeDefined();
    // Capture both the pending drawing and the drawing after the new task arrives.
    const stayedDrawn = page.find('[data-execution-map="bound"]') !== null;
    const answer = madeUpAnswer('/api/b/alpha/task/read');
    if (answer === undefined || !('json' in answer)) throw new Error('no task fixture');
    await act(async () => {
      release?.(Response.json(answer.json, { status: answer.status }));
    });
    await tick();
    expect({
      stayedDrawn,
      selected: page.find('[data-tg-node="send"]')?.getAttribute('aria-pressed'),
    }).toEqual({ stayedDrawn: true, selected: 'true' });
  } finally {
    await page.unmount();
  }
});
