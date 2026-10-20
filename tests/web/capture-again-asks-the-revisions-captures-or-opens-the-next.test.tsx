// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// PROTO-GAPS row 4: the workspace's Capture again. A revision under review with no capture
// asked asks its own (`review.capture`); one asked already opens the next revision of the
// review's own task, page and file (`review.open`) and asks that one's, as the server's
// CAPTURE_ALREADY_ASKED says to. A retry after a lost answer resends both attempts as they
// were, and the workspace reads the review again once the capture is asked.
import { afterEach, expect, it } from 'vitest';
import type { ReviewReadResult } from '../../packages/core-wire/src/index.ts';
import { ReviewWorkspaceScreen } from '../../apps/web/src/screens/review/ReviewWorkspace.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { REVIEW, REVIEW_ID, pictureOf } from '../visual/made-up-review.ts';
import { mount, unmountAll, json } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
afterEach(unmountAll);

const NEXT = '66666666-6666-4666-8666-666666666666';

type Sent = { readonly path: string; readonly body: Record<string, unknown> };

function clientWith(read: ReviewReadResult, lose: (path: string, at: number) => boolean) {
  const sent: Sent[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: (url, init) =>
      Promise.resolve().then(() => {
        const path = String(url);
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (path.endsWith('/review/read')) {
          sent.push({ path: 'read', body });
          return json(read);
        }
        if (path.endsWith('/review/picture')) return json(pictureOf(body.pictureId));
        const name = path.endsWith('/review/open')
          ? 'open'
          : path.endsWith('/review/capture')
            ? 'capture'
            : undefined;
        if (name === undefined) throw new Error(`Unexpected ${path}`);
        sent.push({ path: name, body });
        if (lose(name, sent.filter((each) => each.path === name).length)) {
          throw new TypeError('network down');
        }
        return name === 'open'
          ? json({ recordId: REVIEW_ID, revision: 3, detail: { revisionId: NEXT, number: 3 } })
          : json({ recordId: REVIEW_ID, revision: 3, detail: { widths: [1480, 390] } });
      }),
  });
  return { client, sent };
}

const writes = (sent: readonly Sent[]) => sent.filter((each) => each.path !== 'read');
const reads = (sent: readonly Sent[]) => sent.filter((each) => each.path === 'read').length;

async function workspace(client: OperationsClient) {
  const view = await mount(
    <ReviewWorkspaceScreen
      client={client}
      grantKey="alpha:member"
      reviewId={REVIEW_ID}
      navigate={() => {}}
    />,
  );
  await tick();
  await tick();
  return view;
}

it('a revision with no capture asked asks its own captures', async () => {
  const after = { ...REVIEW.review.after!, captures: [] };
  const fresh = { ...REVIEW, review: { ...REVIEW.review, after, revisions: [after] } };
  const { client, sent } = clientWith(
    { ...fresh, review: { ...fresh.review, before: null } },
    () => false,
  );
  const view = await workspace(client);
  const before = reads(sent);
  await view.click('[data-capture-again] button');
  await tick();
  expect(writes(sent)).toStrictEqual([
    { path: 'capture', body: { revisionId: after.revisionId, operationId: expect.any(String) } },
  ]);
  expect(reads(sent)).toBeGreaterThan(before);
});

it('a revision asked already opens the next revision of the same page and asks its captures', async () => {
  const { client, sent } = clientWith(REVIEW, () => false);
  const view = await workspace(client);
  const before = reads(sent);
  await view.click('[data-capture-again] button');
  await tick();
  const [open, capture] = writes(sent);
  expect(writes(sent)).toHaveLength(2);
  expect(open).toMatchObject({
    path: 'open',
    body: {
      taskId: REVIEW.review.taskId,
      pageUrl: REVIEW.review.pageUrl,
      path: REVIEW.review.path,
      sourceRevision: 'live',
    },
  });
  expect(capture).toMatchObject({ path: 'capture', body: { revisionId: NEXT } });
  expect(reads(sent)).toBeGreaterThan(before);
});

it('a retry after a lost capture answer resends the same open and capture attempts', async () => {
  const { client, sent } = clientWith(REVIEW, (name, at) => name === 'capture' && at === 1);
  const view = await workspace(client);
  await view.click('[data-capture-again] button');
  await tick();
  await view.click('[data-capture-again] button');
  await tick();
  const [open1, capture1, open2, capture2] = writes(sent);
  expect(writes(sent)).toHaveLength(4);
  expect(open2?.body['operationId']).toBe(open1?.body['operationId']);
  expect(capture2?.body['operationId']).toBe(capture1?.body['operationId']);
});
