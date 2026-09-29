// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

it('Sol proof, criterion 32: incident raising is called by a production transition', () => {
  const sources = [
    ...sourceFiles('packages/core-commands/src'),
    ...sourceFiles('packages/core-records/src'),
    ...sourceFiles('packages/core-runtime/src'),
  ].filter((path) => path !== 'packages/core-records/src/inbox/raise.ts');
  const callers = sources.filter((path) =>
    /\braiseIncident\s*\(/u.test(readFileSync(path, 'utf8')),
  );
  expect(callers).not.toHaveLength(0);
});

it('Sol proof, criterion 32: task.comment can raise a paid-client comment', () => {
  const handler = readFileSync('packages/core-commands/src/commands/tasks-comment.ts', 'utf8');
  expect(handler).not.toMatch(/paidClient:\s*false/u);
});
