// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('T3f client isolation fix review', () => {
  it('Sol proof, criterion 3: wrong-client observe callers hold the relevant write grants', () => {
    const source = readFileSync(join(import.meta.dirname, 't3f-expired-lease.test.ts'), 'utf8');
    const start = source.indexOf('it("client to client:');
    const end = source.indexOf('it("business to business:', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const clientCase = source.slice(start, end);
    const grants = [
      [
        'clientA',
        /grantTo\(tx,\s*clientA,\s*'write',\s*\{\s*kind:\s*'record',\s*id:\s*a\.taskId\s*\}/u,
      ],
      [
        'clientB',
        /grantTo\(tx,\s*clientB,\s*'write',\s*\{\s*kind:\s*'record',\s*id:\s*b\.taskId\s*\}/u,
      ],
    ] as const;
    for (const [client, grant] of grants) {
      expect(
        grant.test(clientCase),
        `task.observe requires write on the claimed task; ${client}'s own-task grant must use that action before its wrong-client refusal proves isolation.`,
      ).toBe(true);
    }
  });
});
