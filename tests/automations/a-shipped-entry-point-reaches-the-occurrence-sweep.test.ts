// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { codeOf, sourcesUnder } from './run-start-scan.ts';

it('a shipped entry point reaches the occurrence sweep', () => {
  const callers = [...sourcesUnder('apps'), ...sourcesUnder('scripts')].filter((path) =>
    /\b(?:sweepOccurrences|claimOccurrence|dispatchOccurrence|occurrenceRunStarter)\b/u.test(
      codeOf(readFileSync(path, 'utf8')),
    ),
  );
  expect(
    callers,
    'an exported library alone does not fire scheduled or event activations',
  ).not.toEqual([]);
});
