// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The task page's Open a review (#2232): `review.open`'s answer is tagged with the form and the
// reader that sent it. An answer that lands after the form has gone (the person left the task,
// or another person signed in) or after the business or person changed under a form still
// shown goes nowhere: it never sends the current view to the previous reader's review.
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { OpenReview } from '../../apps/web/src/screens/task/OpenReview.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, unmountAll, json } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
afterEach(unmountAll);

const TASK = '33333333-3333-4333-8333-333333333333';
const REVIEW = '55555555-5555-4555-8555-555555555555';

/** A client whose `review.open` answers only when the test says so. */
function heldClient(businessKey: string) {
  const sent: Record<string, unknown>[] = [];
  const answers: ((response: Response) => void)[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey,
    signedIn: true,
    fetch: (url, init) => {
      if (!String(url).endsWith('/review/open')) throw new Error(`Unexpected ${String(url)}`);
      sent.push(JSON.parse(String(init?.body ?? '{}')));
      return new Promise<Response>((resolve) => {
        answers.push(resolve);
      });
    },
  });
  const opened = (): void => {
    for (const answer of answers)
      answer(json({ recordId: REVIEW, revision: 1, detail: { reviewId: REVIEW } }));
  };
  return { client, sent, opened };
}

async function submitted(client: OperationsClient, navigated: string[]) {
  const element = (onClient: OperationsClient) => (
    <OpenReview
      client={onClient}
      taskId={TASK}
      onOpened={(id) => navigated.push(`/projects/reviews/${id}`)}
    />
  );
  const view = await mount(element(client));
  await view.click('[data-open-review="start"] button');
  await view.type('[data-open-review="pageUrl"] input', 'https://client-a.example/about');
  await view.type('[data-open-review="path"] input', 'src/pages/about.astro');
  await view.click('form button[type="submit"]');
  return { view, element };
}

it('an open that answers after the form is gone or the reader changed navigates nowhere', async () => {
  // The form is gone: the person left the task, or another reader's page replaced it.
  const navigated: string[] = [];
  const alpha = heldClient('alpha');
  const gone = await submitted(alpha.client, navigated);
  expect(alpha.sent).toHaveLength(1);
  await gone.view.render(<p>Signed in as another person in business bravo</p>);
  act(alpha.opened);
  await tick();
  expect(navigated).toStrictEqual([]);

  // The form is still shown, but the business and person under it changed.
  const first = heldClient('alpha');
  const kept = await submitted(first.client, navigated);
  const bravo = heldClient('bravo');
  await kept.view.render(kept.element(bravo.client));
  act(first.opened);
  await tick();
  expect(navigated).toStrictEqual([]);
});

it('an open that answers for the same form and reader still goes to its review, once per intent', async () => {
  const navigated: string[] = [];
  const alpha = heldClient('alpha');
  const { view } = await submitted(alpha.client, navigated);
  act(alpha.opened);
  await tick();
  expect(navigated).toStrictEqual([`/projects/reviews/${REVIEW}`]);
  expect(alpha.sent).toHaveLength(1);
  await view.unmount();
});
