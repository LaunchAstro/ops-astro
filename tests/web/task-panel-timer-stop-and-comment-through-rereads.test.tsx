// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function, prefer-dom-node-dataset -- Sol's proof, kept as written */
import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TaskPanel } from '../../apps/web/src/screens/task/Panel.tsx';
import { useTaskPanel } from '../../apps/web/src/screens/task/panel-host.ts';
import { task, tick } from './task-page-stub.tsx';
import { json, mount, typeInto, unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

function api(initiallyRunning = false) {
  let reads = 0;
  let running = initiallyRunning;
  let outage = false;
  let holdRead = false;
  let release: ((response: Response) => void) | undefined;
  const stops: string[] = [];
  const answer = () =>
    json({
      ok: true,
      task: task({
        time: {
          entries: [],
          totalMinutes: 0,
          running: running
            ? { entryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', startedAt: '2026-10-04T01:00:00Z' }
            : null,
        },
      }),
    });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.endsWith('/task/read')) {
      reads += 1;
      if (outage) return json({}, 503);
      if (holdRead)
        return await new Promise<Response>((resolve) => {
          release = resolve;
        });
      return answer();
    }
    if (path.endsWith('/time/start')) {
      running = true;
      return json({
        recordId: null,
        revision: null,
        detail: {
          entryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          startedAt: '2026-10-04T01:00:00Z',
        },
      });
    }
    if (path.endsWith('/time/stop')) {
      stops.push(String(init?.body));
      running = false;
      return json({ recordId: null, revision: null });
    }
    if (path.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (path.endsWith('/client/list')) return json({ ok: true, clients: [] });
    if (path.endsWith('/task/board')) return json({ ok: true, tasks: [] });
    if (path.endsWith('/preference/read')) return json({ ok: true, preferences: {} });
    if (path.includes('/live')) return new Response(null, { status: 404 });
    throw new Error(`Unexpected route ${path}`);
  };
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    stops,
    reads: () => reads,
    running: () => running,
    outage: (next: boolean) => {
      outage = next;
    },
    hold: () => {
      holdRead = true;
    },
    release: () => {
      release?.(answer());
    },
  };
}

function Host(props: { readonly client: OperationsClient }) {
  const panel = useTaskPanel({ key: 'alpha:ada:session', person: 'alpha:ada', storage: null });
  return (
    <>
      <button data-open onClick={() => panel.host.open('Proj-Verity-Pacing', 'reply', 'internal')}>
        Open
      </button>
      <button data-reread onClick={panel.changed}>
        Reread
      </button>
      <button
        data-close
        onClick={() => {
          panel.close();
        }}
      >
        Close
      </button>
      {panel.opening === null ? null : (
        <TaskPanel
          client={props.client}
          grantKey="alpha:ada:session"
          opening={panel.opening}
          changes={panel.host.changes}
          onChanged={panel.changed}
          onClose={panel.close}
          onLeaving={panel.leaving}
        />
      )}
    </>
  );
}

// Sol OW-091.1 criterion 5, retitled by what it proves; its body is Sol's.
it('closing after timer start stops it before its delayed reread', async () => {
  const server = api();
  const view = await mount(<Host client={server.client} />);
  await view.click('[data-open]');
  await tick();
  expect(view.find('[data-timer]')?.getAttribute('data-running')).toBe('false');
  server.hold();
  await view.click('[data-timer]');
  await tick();
  expect(server.running()).toBe(true);
  expect(server.reads()).toBe(2);
  try {
    await view.click('[data-close]');
    await tick();
    expect(view.find('[data-task-panel]')).toBeNull();
    expect(server.stops).toHaveLength(1);
    expect(server.running()).toBe(false);
  } finally {
    server.release();
    await tick();
  }
});

// Sol OW-091.2 criterion correctness, retitled by what it proves; its body is Sol's.
it('closing after a read outage still stops the known running timer', async () => {
  const server = api(true);
  const view = await mount(<Host client={server.client} />);
  await view.click('[data-open]');
  await tick();
  expect(view.find('[data-timer]')?.getAttribute('data-running')).toBe('true');
  server.outage(true);
  await view.click('[data-reread]');
  await tick();
  expect(view.find('[data-outcome="unavailable"]')).not.toBeNull();
  await view.click('[data-close]');
  await tick();
  expect(server.stops).toHaveLength(1);
  expect(server.running()).toBe(false);
});

// Sol OW-091.3 criterion correctness, retitled by what it proves; its body is Sol's.
it('an unsent panel comment survives an outage and retry', async () => {
  const server = api();
  const view = await mount(<Host client={server.client} />);
  await view.click('[data-open]');
  await tick();
  await typeInto(view, '#panel-comment-body', 'Private unsent work');
  expect(view.host.querySelector<HTMLTextAreaElement>('#panel-comment-body')?.value).toBe(
    'Private unsent work',
  );
  server.outage(true);
  await view.click('[data-reread]');
  await tick();
  expect(view.find('[data-outcome="unavailable"]')).not.toBeNull();
  server.outage(false);
  await view.click('[data-outcome="unavailable"] button');
  await tick();
  expect(server.reads()).toBe(3);
  expect(view.host.querySelector<HTMLTextAreaElement>('#panel-comment-body')?.value).toBe(
    'Private unsent work',
  );
});
