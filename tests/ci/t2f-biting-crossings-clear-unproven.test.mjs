// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PARTS, classify, everyInvariantBites } from './self-test/mutations.ts';
import { everyLine, ran } from './self-test/fake-lines.ts';

test('T2f crossings that bite clear the known-unproven verdict', () => {
  const part = PARTS.find((one) => one.id === 'T2f');
  assert.ok(part);
  const cases = [
    ...part.invariants.map((name) => `${name}: the case`),
    ...(part.crossings ?? []).map((one) => one.case),
  ].map((name) => ({ name, passed: false }));
  const lines = everyLine().map((line) =>
    line.case.startsWith('T4-N4 T2f reverted') ? classify(line.case, ran({ cases })) : line,
  );
  assert.equal(lines.find((line) => line.case.startsWith('T4-N4 T2f'))?.status, 'pass');
  const verdict = everyInvariantBites(lines);
  assert.equal(verdict.status, 'pass', verdict.detail);
});
