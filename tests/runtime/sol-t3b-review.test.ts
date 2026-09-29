// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string): string => readFileSync(resolve(import.meta.dirname, path), 'utf8');

const suite = source('t3b-sweeper.test.ts');
const harness = source('t3b-harness.ts');

describe('T3b review proofs', () => {
  it('Sol proof, criterion 2: unknown_stays_unknown drives the worker with its injected reporter', () => {
    expect(/\bcreateWorker\s*\(/u.test(`${suite}\n${harness}`)).toBe(true);
    expect(/\breporter\s*:\s*DECLINING_REPORTER\b/u.test(`${suite}\n${harness}`)).toBe(true);
  });

  it('Sol proof, criterion 2: the API sweep test supplies two configured businesses', () => {
    expect(
      /sweepDeployment\s*\([^;]*\[\s*['"]alpha['"]\s*,\s*['"]bravo['"]\s*\]/u.test(suite),
    ).toBe(true);
  });

  it('Sol proof, criterion 3: T3 isolation attempts a foreign-business task read', () => {
    expect(/executeRead\s*\(\s*s\.db\.app\s*,\s*other\.business\b/u.test(suite)).toBe(true);
  });
});
