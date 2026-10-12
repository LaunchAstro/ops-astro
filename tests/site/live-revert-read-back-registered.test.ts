// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's revert on the effect register: a revert the provider read back as
// already landed is registered as the send's answer would be, with the time
// the runner first took it up, so a run that lost its lease before the receipt
// leaves the next run observing it, never asking a person about it. Every
// provider here is a double.

import { describe, expect, it } from 'vitest';
import { doubles } from './c80-runner-doubles.ts';
import {
  approved,
  entries,
  expireLease,
  publish,
  receipt,
  renewLease,
  revert,
  serverUrl,
  useRegisterWorld,
} from './c80-register-world.ts';

useRegisterWorld();

const LANDED = { state: 'landed', value: { revision: 'rev-3', deploymentId: 'dep-3' } } as const;

describe.skipIf(serverUrl === undefined)('C80 revert, landed on read back', () => {
  it('registers a landed read back under the expired lease, so the next run observes it', async () => {
    const id = await approved();
    expect(await publish(id, doubles())).toMatchObject({ kind: 'recorded', state: 'live' });
    const lost = doubles({
      revertReadBack: async () => {
        await expireLease();
        return LANDED;
      },
    });
    try {
      expect(await revert(id, lost)).toMatchObject({ kind: 'unrecorded', outcome: 'reverted' });
      await renewLease();
      const later = doubles();
      expect(await revert(id, later)).toMatchObject({ kind: 'recorded', state: 'reverted' });
      expect([lost.seen.reverted, later.seen.reverted, later.seen.raised]).toEqual([0, 0, []]);
      const entry = (await entries(id)).find((one) => one.command === 'site.revert');
      expect(entry?.detail).toMatchObject({ revision: 'rev-3', deploymentId: 'dep-3' });
      const observed = await receipt(id, 'revert');
      expect(observed['decided_at']).toEqual({ observed: entry?.detail['decidedAt'] });
      expect(observed['published_revision']).toEqual({ observed: 'rev-3' });
    } finally {
      await renewLease();
    }
  });
});
