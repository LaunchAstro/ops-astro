// SPDX-License-Identifier: AGPL-3.0-only
//
// The live correction's runner ports and serving read answer for one run at a
// time: the refusals a run's receipt records are that run's alone, read once,
// and a deployment read that fails is unserved (a person is asked), never
// pending as a deployment not ready yet would be.

import { expect, it } from 'vitest';
import { whileServed } from '../../packages/core-connectors/src/site/serving.ts';
import { siteRunnerPorts } from '../../packages/core-commands/src/commands/live-correction-ports.ts';

const DEPLOYED = { deploymentId: 'dpl_1', revision: 'c0ffee' };
const failed = () =>
  Promise.resolve({ kind: 'refused', code: 'PROVIDER_STATUS_UNEXPECTED' } as const);
const notYet = () =>
  Promise.resolve({ kind: 'ok', value: { revision: 'c0ffee', served: false } } as const);

it('a deployment read that fails is unserved, not pending', async () => {
  let captured = 0;
  const result = await whileServed(failed, DEPLOYED, () => {
    captured += 1;
    return Promise.resolve({ page: 'x' });
  });
  expect(result).toBe('unserved');
  expect(captured).toBe(0);
});

it('a deployment not ready yet is still pending (control)', async () => {
  expect(await whileServed(notYet, DEPLOYED, () => Promise.resolve({ page: 'x' }))).toBe('pending');
});

it('the refusals a run records are read once, so the next run starts with none', () => {
  const ports = siteRunnerPorts(
    { proposal: { branch: 'seam-1' } } as never,
    { capture: {} } as never,
  );
  ports.capture.record?.({ code: 'DEPLOYMENT_NOT_SERVING' } as never);
  expect(ports.refusals()).toStrictEqual(['DEPLOYMENT_NOT_SERVING']);
  expect(ports.refusals()).toStrictEqual([]);
});
