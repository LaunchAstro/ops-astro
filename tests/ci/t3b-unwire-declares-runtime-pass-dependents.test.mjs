// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { PARTS, openScratch, revertPart } from './self-test/mutations.ts';

const root = resolve(import.meta.dirname, '../..');

test('T3b unwire declares T3d2, whose recovery proof needs its interval pass', () => {
  const part = PARTS.find((candidate) => candidate.id === 'T3b');
  assert.ok(part);
  const runtimeProof = readFileSync(join(root, 'tests/acceptance/runtime-proofs.test.tsx'), 'utf8');
  const server = readFileSync(join(root, 'apps/api/server.ts'), 'utf8');
  const apiStart = runtimeProof.indexOf("if (!up) await api('t3d2-api-a2')");
  const workStart = runtimeProof.indexOf('const markOnly = await p.approvedWork(');
  assert.ok(apiStart >= 0 && apiStart < workStart, 'F2 starts its API before creating the work');
  assert.ok(runtimeProof.includes("The API's own pass, on its interval"));
  assert.ok(runtimeProof.includes("(await attempts(applied.taskId))[0]?.state === 'settled'"));
  assert.ok(server.includes('const sweeper = startSweeper('));

  const scratch = openScratch();
  try {
    assert.equal(revertPart(scratch, part, true).applied, true);
    const unwiredServer = readFileSync(join(scratch.dir, 'apps/api/server.ts'), 'utf8');
    assert.ok(!unwiredServer.includes('const sweeper = startSweeper('));
    assert.ok(
      part.dependents?.some((dependent) => dependent.part === 'T3d2'),
      'T3d2 F2 waits for the interval pass removed by T3b\'s unwire',
    );
  } finally {
    scratch.close();
  }
});
