// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A standing approval whose filing's answer was lost, then corrected and filed
// again (#1427). The server binds the lost filing's draft to the values it
// filed, so the corrected values under that draft are refused naming
// `draftId`. The person must still be able to file what they corrected, and
// the lost filing must stay one mandate.

import { afterEach, expect, it } from 'vitest';
import {
  fill,
  filings,
  regionOn,
  stubServer,
  tick,
  unmountOpened,
  valueOf,
} from './graduation-draft-server.tsx';

afterEach(unmountOpened);

it('a lost filing edited afterwards still files the edited values, and the lost one once', async () => {
  const stub = stubServer({ loseAfter: ['/mandate/file'] });
  const page = await regionOn(stub);
  await fill(page);
  await page.click('[data-mandate-add]');
  await tick();
  // The answer never came back; the person corrects the sentence and files again.
  await page.type('[data-mandate-label]', 'Approve posts for Client A');
  await page.click('[data-mandate-add]');
  await tick();
  if (valueOf(page, '[data-mandate-label]') !== '') {
    await page.click('[data-mandate-add]');
    await tick();
  }
  const labels = stub.held().map((one) => one.label);
  expect(labels.filter((label) => label === 'Approve posts')).toHaveLength(1);
  expect(
    labels,
    `filings sent: ${JSON.stringify(filings(stub).map((one) => [one['label'], one['draftId']]))}`,
  ).toContain('Approve posts for Client A');
});
