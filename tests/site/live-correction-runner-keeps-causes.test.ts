// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's runner keeps what went wrong: a failed receipt holds every refusal
// the guarded calls recorded beside its own code, and the register takes an
// effect only from a lease at its own fence. Every provider here is a double.

import { describe, expect, it } from 'vitest';
import { BEFORE } from './c80-world.ts';
import { doubles } from './c80-runner-doubles.ts';
import { registerCorrectionEffect } from '../../packages/core-commands/src/commands/live-correction-effect.ts';
import {
  approved,
  at,
  entries,
  lease,
  publish,
  receipt,
  serverUrl,
  useRegisterWorld,
  w,
} from './c80-register-world.ts';

useRegisterWorld();

describe.skipIf(serverUrl === undefined)('C80 publish, a failed receipt', () => {
  it('keeps the refusals the guarded calls recorded beside the code it failed on', async () => {
    const id = await approved();
    const ports = doubles({
      readSource: () => {
        ports.seen.sourceReads += 1;
        const read = { kind: 'ok', value: { content: BEFORE, revision: 'rev-1' } } as const;
        const lost = { kind: 'unknown', code: 'PROVIDER_TIMEOUT' } as const;
        return Promise.resolve(ports.seen.sourceReads === 1 ? read : lost);
      },
      refusals: () => (ports.seen.sourceReads > 1 ? ['PROVIDER_TIMEOUT'] : []),
    });
    expect(await publish(id, ports)).toMatchObject({ kind: 'recorded', state: 'failed' });
    expect((await receipt(id, 'publish'))['refusals_raised']).toEqual({
      observed: 'PROVIDER_TIMEOUT CONTENT_DRIFT_UNCHECKED',
    });
  });
});

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
