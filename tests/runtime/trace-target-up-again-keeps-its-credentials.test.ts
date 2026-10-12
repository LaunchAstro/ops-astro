// SPDX-License-Identifier: AGPL-3.0-only
//
// `trace-target.ts up` run again without `down` keeps the target's volumes,
// so it keeps the passwords, keys and project pair those volumes were made
// with. Only the port may change.

import { afterAll, expect, it } from 'vitest';
import { traceTarget } from './trace-target-stub.fixture.ts';

const target = traceTarget();
afterAll(() => target.remove());

it('a second up keeps the settings the first one made, and takes its own port', () => {
  target.run(['up', '3910']);
  const { TRACE_TARGET_PORT: firstPort, ...first } = target.settings();
  target.run(['up', '3911']);
  const { TRACE_TARGET_PORT: secondPort, ...second } = target.settings();
  expect(second).toStrictEqual(first);
  expect([firstPort, secondPort]).toStrictEqual(['3910', '3911']);
});
