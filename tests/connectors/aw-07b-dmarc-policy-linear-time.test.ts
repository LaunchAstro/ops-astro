// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b sender: the root's DMARC record is DNS text anyone who owns the
// domain writes. Reading it must take time in step with its length, so a
// record padded with spaces cannot hold the server's one event loop.

import { expect, it } from 'vitest';
import { dmarcPolicy } from '../../packages/core-connectors/src/index.ts';

it('AW-07b sender: a DMARC record padded with thousands of spaces is read at once', () => {
  const started = performance.now();
  expect(dmarcPolicy([`v=DMARC1;${' '.repeat(3000)}`])).toBe('invalid');
  expect(dmarcPolicy([`v=DMARC1; p=${' '.repeat(3000)}reject`])).toBe('reject');
  expect(performance.now() - started).toBeLessThan(250);
});
