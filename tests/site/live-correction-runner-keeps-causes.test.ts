// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's runner keeps what went wrong: the register takes an effect only from
// a lease at its own fence. Every provider here is a double.

import { describe, expect, it } from 'vitest';
import { registerCorrectionEffect } from '../../packages/core-commands/src/commands/live-correction-effect.ts';
import {
  approved,
  at,
  entries,
  lease,
  serverUrl,
  useRegisterWorld,
  w,
} from './c80-register-world.ts';

useRegisterWorld();

describe.skipIf(serverUrl === undefined)('C80 effect register, the fence', () => {
  it('writes no entry for the lease holder at a fence other than its lease’s', async () => {
    const id = await approved();
    const answer = { revision: 'rev-2', deploymentId: 'dep-2', dispatchToken: 'sha256:any' };
    const stale = { ...at(id), fence: lease.fence + 1 };
    const correction = { id, taskId: lease.taskId };
    expect(
      await registerCorrectionEffect(w.world.db.app, stale, correction, 'publish', answer),
    ).toBe(false);
    expect(await entries(id)).toEqual([]);
  });
});
