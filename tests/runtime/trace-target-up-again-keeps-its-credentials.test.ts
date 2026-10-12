// SPDX-License-Identifier: AGPL-3.0-only
//
// `trace-target.ts up` run again without `down` keeps the target's volumes,
// so it keeps the passwords, keys and project pair those volumes were made
// with. Only the port may change.

import { afterAll, expect, it } from 'vitest';
import { traceTarget } from './trace-target-stub.fixture.ts';

const target = traceTarget();
afterAll(() => target.remove());

const withoutPort = (settings: string): string =>
  settings
    .split('\n')
    .filter((line) => !line.startsWith('TRACE_TARGET_PORT='))
    .join('\n');

it('a second up keeps the settings the first one made, and takes its own port', () => {
  target.run(['up', '3910']);
  const first = target.settings();
  target.run(['up', '3911']);
  const second = target.settings();
  expect(withoutPort(second)).toBe(withoutPort(first));
  expect(second).toContain('TRACE_TARGET_PORT=3911\n');
});
