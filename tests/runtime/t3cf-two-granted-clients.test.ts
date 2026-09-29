// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (name: string): string => readFileSync(join(import.meta.dirname, name), 'utf8');

describe('T3c and T3f isolation review proofs', () => {
  it('T3c crosses two granted clients on write-off', () => {
    const suite = source('t3c-write-off-isolation.test.ts');
    const start = suite.indexOf('it("client to client:');
    const end = suite.indexOf('it("task to task:', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const caseSource = suite.slice(start, end);
    expect(
      (caseSource.match(/\.client\s*\(/gu) ?? []).length,
      'The write-off isolation case must create two clients in the same business, each with a grant on its own task, then try both cross-client write-offs.',
    ).toBeGreaterThanOrEqual(2);
    expect((caseSource.match(/\bgrantTo\s*\(/gu) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((caseSource.match(/\bwriteOffBody\s*\(/gu) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('T3f crosses two clients on expired observation', () => {
    const suite = source('t3f-expired-lease.test.ts');
    expect(
      (suite.match(/\.client\s*\(/gu) ?? []).length,
      'The expired-observe isolation case must create two clients in one business, each with a grant on its own task, then try a wrong-client observation and check both money states.',
    ).toBeGreaterThanOrEqual(2);
    expect(/\bit\(['"]client to client:/u.test(suite)).toBe(true);
    expect((suite.match(/\bgrantTo\s*\(/gu) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
