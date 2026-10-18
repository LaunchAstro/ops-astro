// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A first question asked on a page loses its answer, and its tab gives the
// page up. Resent unchanged, it replays with the page put back, and its
// question counts as asked on that page (#1467's rule), so a refusal for the
// page that the replay brings back takes back the page's note.

import { afterEach, expect, it } from 'vitest';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import { lines, opened, standIn } from './resend-fixture.tsx';

afterEach(unmountAll);

const A = 'Question A';
const REFUSED = 'Models are off for this page.';
const UNREAD = 'note: This page couldn’t be read into context, so nothing on it was sent.';

it('a replayed first question whose answer refuses its page takes back the page note', async () => {
  const api = standIn(
    { 'conversation.start': ['drop'] },
    {},
    { reply: () => ({ answered: false, code: 'MODEL_OFF', words: REFUSED }) },
  );
  const drawer = await opened(api.client);
  await drawer.addPage();
  await drawer.ask(A);
  expect(lines(), 'nothing refused the page yet').not.toContain(UNREAD);
  await drawer.ask(A);
  expect(lines(), 'the replay brings the refusal').toContain(`failed: ${REFUSED}`);
  expect(lines(), 'the resend was asked on the page put back').toContain(UNREAD);
});
