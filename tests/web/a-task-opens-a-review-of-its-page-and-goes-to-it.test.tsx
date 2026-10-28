// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// PROTO-GAPS row 4: the task page opens a review of a page its site binds through
// `review.open`, and goes to the opened review's workspace. A retry after a lost answer is the
// same attempt; a refusal is shown in the server's words and goes nowhere.
import { afterEach, expect, it } from 'vitest';
import { OpenReview } from '../../apps/web/src/screens/task/OpenReview.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, unmountAll, json } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
afterEach(unmountAll);

const TASK = '33333333-3333-4333-8333-333333333333';
const REVIEW = '55555555-5555-4555-8555-555555555555';

function clientWith(answer: () => Promise<Response>) {
  const sent: Record<string, unknown>[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: async (url, init) => {
      if (!String(url).endsWith('/review/open')) throw new Error(`Unexpected ${String(url)}`);
      sent.push(JSON.parse(String(init?.body ?? '{}')));
      return await answer();
    },
  });
  return { client, sent };
}

async function openFor(client: OperationsClient, opened: string[]) {
  const view = await mount(
    <OpenReview client={client} taskId={TASK} onOpened={(id) => opened.push(id)} />,
  );
  await view.click('[data-open-review="start"] button');
  await view.type('[data-open-review="pageUrl"] input', 'https://bikes.example/about');
  await view.type('[data-open-review="path"] input', 'src/pages/about.astro');
  return view;
}

it('opens a review of the named page and goes to its workspace', async () => {
  const opened: string[] = [];
  const { client, sent } = clientWith(() =>
    Promise.resolve(json({ recordId: REVIEW, revision: 1, detail: { reviewId: REVIEW } })),
  );
  const view = await openFor(client, opened);
  await view.click('form button[type="submit"]');
  await tick();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    taskId: TASK,
    pageUrl: 'https://bikes.example/about',
    path: 'src/pages/about.astro',
    sourceRevision: 'live',
  });
  expect(opened).toStrictEqual([REVIEW]);
});

it('a retry after a lost answer sends the same attempt', async () => {
  const opened: string[] = [];
  let lost = true;
  const { client, sent } = clientWith(() => {
    if (lost) {
      lost = false;
      return Promise.reject(new TypeError('network down'));
    }
    return Promise.resolve(json({ recordId: REVIEW, revision: 1 }));
  });
  const view = await openFor(client, opened);
  await view.click('form button[type="submit"]');
  await tick();
  expect(opened).toStrictEqual([]);
  await view.click('form button[type="submit"]');
  await tick();
  expect(sent).toHaveLength(2);
  expect(sent[1]?.['operationId']).toBe(sent[0]?.['operationId']);
  expect(opened).toStrictEqual([REVIEW]);
});

it('a refused open says why and goes nowhere', async () => {
  const opened: string[] = [];
  const { client } = clientWith(() =>
    Promise.resolve(
      json(
        {
          refused: true,
          code: 'PAGE_OUTSIDE_HOLDER_SITE',
          names: ['pageUrl', 'path'],
          fixes: ['Name a page the task’s own site binds, and its file, as the site holds them.'],
        },
        422,
      ),
    ),
  );
  const view = await openFor(client, opened);
  await view.click('form button[type="submit"]');
  await tick();
  expect(view.text()).toContain('PAGE_OUTSIDE_HOLDER_SITE');
  expect(opened).toStrictEqual([]);
});
