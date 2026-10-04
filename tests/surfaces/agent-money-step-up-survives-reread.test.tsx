// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function, no-promise-executor-return, require-await -- Sol's proof, kept as written */
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { StepUpContext } from '../../apps/web/src/records/use-money-command.ts';
import { mount, type Mounted } from './mount.tsx';
import { lineage } from './mp-6-1-agent-fixtures.tsx';

const ID = '22222222-2222-4222-8222-222222222222';
const pages: Mounted[] = [];
afterEach(async () => {
  // Each unmount owns a React act scope; keep those scopes sequential.
  // eslint-disable-next-line no-await-in-loop
  for (const page of pages.splice(0)) await page.unmount();
});
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function tick(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > end) throw new Error('proof prerequisite did not arrive');
    // Poll after React has flushed the preceding tick.
    // eslint-disable-next-line no-await-in-loop
    await tick();
  }
}
function server(savedJobs = false) {
  const task = {
    id: ID,
    key: 'TSK-2',
    title: 'Review task',
    description: null,
    state: null,
    assignee: null,
    due: null,
    priority: null,
    completedAt: null,
    revision: 1,
    history: [],
    steps: [],
    alerts: [],
    comments: [
      {
        id: 'comment-1',
        body: 'Stored words',
        author: 'Ana',
        own: true,
        audience: 'internal',
        comment_type: 'note',
        posted_at: '2026-10-01T00:00:00Z',
      },
    ],
    proposals: [lineage()],
    ledger: {
      envelopes: [],
      stops: [
        {
          askId: 'ask-1',
          runId: 'run-1',
          number: 1,
          kind: 'stop',
          ceilingMinor: 400,
          spentMinor: 390,
          currency: 'AUD',
          raisedAt: '2026-10-01T00:00:00Z',
          answer: null,
          awaitingSecond: null,
        },
      ],
    },
  };
  const saves: unknown[] = [];
  let creates = 0;
  let topUps = 0;
  let reads = 0;
  let finishCreate: ((response: Response) => void) | undefined;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const at = String(url);
    if (at.endsWith('/task/read')) {
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 0));
      return json({ ok: true, task });
    }
    if (at.endsWith('/run/top_up')) {
      topUps += 1;
      return json(
        {
          refused: true,
          code: 'STEP_UP_REQUIRED',
          names: [],
          fixes: ['A money action needs the second factor in the last 60 minutes.'],
        },
        403,
      );
    }
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/preference/read'))
      return json({ ok: true, preferences: { 'agent.jobList': savedJobs } });
    if (at.endsWith('/preference/save')) {
      saves.push(JSON.parse(String(init?.body)));
      return json({ ok: true, revision: 1 });
    }
    if (at.endsWith('/task/create')) {
      creates += 1;
      return await new Promise<Response>((resolve) => {
        finishCreate = resolve;
      });
    }
    if (at.includes('/live?'))
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
      );
    return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
  };
  const client = new OperationsClient({ origin: '', businessKey: 'b', signedIn: true, fetch });
  return {
    client,
    saves,
    creates: () => creates,
    topUps: () => topUps,
    reads: () => reads,
    finish: () => finishCreate?.(json({ ok: true, recordId: 'child-1', revision: 1 })),
    invalidate: () => {
      task.revision += 1;
      stream?.enqueue(new TextEncoder().encode(`event: invalidate\ndata: task:${ID}\n\n`));
    },
  };
}
async function open(savedJobs = false) {
  const api = server(savedJobs);
  const page = await mount(
    <StepUpContext.Provider value={async () => ({ ok: true, sessionId: 'stepped-up' })}>
      <TaskDetailScreen client={api.client} grantKey="b:ana" taskKey={ID} />
    </StepUpContext.Provider>,
  );
  pages.push(page);
  await until(() => page.find('[data-step-add]') !== null);
  await tick();
  return { api, page };
}

// Sol OW-085.4 criterion correctness, retitled by what it proves; its body is Sol's.
it('a refused Agent money write retains its authenticator prompt across the reread', async () => {
  const { api, page } = await open();
  await page.click('[data-tabs="perspective"] [role="tab"]:nth-of-type(2)');
  await page.type('[data-section="agent"] [data-stop="amount"]', '2.50');
  await page.click('[data-section="agent"] [data-stop="top-up"]');
  expect(api.topUps()).toBe(1);
  await until(() => api.reads() >= 2 && page.find('[data-outcome="ready"]') !== null);
  expect(page.find('[data-step-up="prompt"]')).not.toBeNull();
});
