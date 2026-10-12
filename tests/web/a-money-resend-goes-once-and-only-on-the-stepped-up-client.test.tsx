// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A money write held for its code (C59) goes again once, and only on the
// client built for the sign-in the step-up returned. It reaches that client
// by one of two paths: the check's own answer, when the client rendered
// first, or the client's arrival, when the answer came first. A client
// rebuilt for another sign-in in between gets nothing and does not use up
// the resend; a write withdrawn while the code was checked goes on neither
// path.

import { afterEach, describe, expect, it } from 'vitest';
import { openResendProbe, STEPPED_UP, type ResendProbe } from './money-resend-probe.tsx';

const probes: ResendProbe[] = [];
afterEach(async () => {
  for (const probe of probes.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await probe.view.unmount();
  }
});

/** A top-up refused on `sid-old`, its code confirmed and still being checked. */
async function checking(): Promise<ResendProbe> {
  const probe = await openResendProbe();
  probes.push(probe);
  await probe.topUp();
  await probe.confirm();
  expect(probe.sent).toStrictEqual(['sid-old']);
  return probe;
}

describe('a money resend after a passed code', () => {
  it('goes once on the stepped-up client when that client rendered before the check returned', async () => {
    const probe = await checking();
    await probe.renderOn(STEPPED_UP);
    expect(probe.sent).toStrictEqual(['sid-old']);
    await probe.pass();
    expect(probe.sent).toStrictEqual(['sid-old', STEPPED_UP]);
    await probe.renderOn(STEPPED_UP);
    expect(probe.sent).toStrictEqual(['sid-old', STEPPED_UP]);
  });

  it('skips a client rebuilt for another sign-in after the check, then goes once on the stepped-up client', async () => {
    const probe = await checking();
    await probe.pass();
    expect(probe.sent).toStrictEqual(['sid-old']);
    await probe.renderOn('sid-other');
    expect(probe.sent, 'nothing goes on a client for another sign-in').toStrictEqual(['sid-old']);
    await probe.renderOn(STEPPED_UP);
    expect(probe.sent).toStrictEqual(['sid-old', STEPPED_UP]);
    await probe.renderOn(STEPPED_UP);
    expect(probe.sent, 'a held write is delivered at most once').toStrictEqual([
      'sid-old',
      STEPPED_UP,
    ]);
  });

  it('sends nothing when withdrawn during the check and the stepped-up client rendered first', async () => {
    const probe = await checking();
    await probe.renderOn(STEPPED_UP);
    await probe.cancel();
    await probe.pass();
    await probe.renderOn(STEPPED_UP);
    expect(probe.sent).toStrictEqual(['sid-old']);
  });

  it('sends nothing when withdrawn during the check and the stepped-up client lands after it', async () => {
    const probe = await checking();
    await probe.cancel();
    await probe.pass();
    await probe.renderOn(STEPPED_UP);
    expect(probe.sent).toStrictEqual(['sid-old']);
  });
});
