// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unsent } from './cq-8-support.ts';

const isolationSuite = readFileSync(join(import.meta.dirname, 'cq-8-db.test.ts'), 'utf8');

describe('how strong the CQ-8 isolation test is', () => {
  it('isolation detects a single foreign task write', () => {
    const isolation = isolationSuite.slice(isolationSuite.indexOf("it('CQ-8 isolation:"));
    // An accepted reparent or rank advances revision 1 to 2. The named test
    // must compare the final revision with its value before the foreign calls.
    expect(isolation).not.toMatch(/toBeLessThanOrEqual\(2\)/u);
    expect(isolation).toMatch(/expect\(await revisionOfIn\(to\.id, task\.id\)\)\.toBe\(/u);
  });

  it('the wording guard detects unsent stored text', () => {
    const refusal = { code: 'LEASE_EXPIRED', fixes: ['the named lease is released'] };
    const sent = { leaseId: '3a6fd358-4946-4a40-bdaa-0cf75af74c57', fence: 1 };
    expect(unsent(refusal, sent)).not.toEqual([]);
  });
});
