// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The step-up race (C59): once a code has passed, the old sign-in's cookie is
// being cleared. A client rebuilt for some other reason, still on that old
// sign-in, can render before the client for the new one. The held money
// write must not go on it, where the cleared cookie would end the tab; it
// waits for the stepped-up client and goes once there.

import { afterEach, expect, it } from 'vitest';
import { openResendProbe, STEPPED_UP, type ResendProbe } from './money-resend-probe.tsx';

const probes: ResendProbe[] = [];
afterEach(async () => {
  for (const probe of probes.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await probe.view.unmount();
  }
});

it('a money resend never goes on an unrelated client rebuilt on the old sign-in after the code passed', async () => {
  const probe = await openResendProbe();
  probes.push(probe);
  await probe.topUp();
  await probe.confirm();
  await probe.pass();
  await probe.renderOn('sid-old');
  expect(probe.sent, 'nothing goes on the old sign-in, whose cookie is cleared').toStrictEqual([
    'sid-old',
  ]);
  await probe.renderOn(STEPPED_UP);
  expect(probe.sent).toStrictEqual(['sid-old', STEPPED_UP]);
});
