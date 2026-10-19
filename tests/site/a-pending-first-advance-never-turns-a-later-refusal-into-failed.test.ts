// SPDX-License-Identifier: AGPL-3.0-only
//
// A send whose answer was lost may still land later. Once one has, a later
// refusal (a fast-forward refused, or the ref not found) proves nothing about
// it: the publish stays `unknown` with one person task, never `failed`, until a
// read back proves the landing. Mutant that turns it red: drop the uncertainty
// carried after an unknown send, and the refusal becomes `failed`.

import { expect, it } from 'vitest';
import { publishCorrection } from '../../packages/core-connectors/src/index.ts';
import { absent, job, landed, refusal, scripted, timeout } from './advance-attempts.ts';

it.each(['not_fast_forward', 'ref_missing'])(
  'keeps a %s refusal after a lost send unknown, with one task',
  async (proof) => {
    // Read back before the first send, after its lost answer, and after the refusal.
    const ports = scripted({ sends: [timeout, refusal(proof)], backs: [absent, absent, absent] });
    expect(await publishCorrection(job(), ports)).toMatchObject({
      state: 'unknown',
      code: 'EARLIER_SEND_UNSETTLED',
    });
    expect(ports.sent()).toBe(2);
    expect(ports.raised).toEqual(['EARLIER_SEND_UNSETTLED']);
  },
);

it('settles on the landing when the pending send lands after the refusal', async () => {
  const pending = scripted({
    sends: [timeout, refusal('not_fast_forward')],
    backs: [absent, absent, absent],
  });
  await publishCorrection(job(), pending);
  const later = scripted({ sends: [], backs: [landed] });
  expect(await publishCorrection(job(), later)).toMatchObject({
    state: 'accepted',
    revision: 'c0ffee01',
  });
  expect(later.sent()).toBe(0);
});

it('is still a proven failure when no earlier send was in doubt', async () => {
  const ports = scripted({ sends: [refusal('not_fast_forward')], backs: [absent, absent] });
  expect(await publishCorrection(job(), ports)).toMatchObject({
    state: 'failed',
    proof: 'not_fast_forward',
  });
  expect(ports.sent()).toBe(1);
});
