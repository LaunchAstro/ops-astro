// SPDX-License-Identifier: AGPL-3.0-only
//
// A comment closed earlier on the line does not hide the named sign-in call
// after it: parity still finds the call and passes it.

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const PARITY = '../../scripts/command-parity.mjs';
const { run } = (await import(
  /* @vite-ignore */
  PARITY
)) as { run: (files: Map<string, string>) => { failures: string[] } };

it('passes the named sign-in call after a closed inline comment', () => {
  const entry = readFileSync('apps/web/src/main.tsx', 'utf8');
  const call = "window.fetch('/api/sign-in')";
  expect(entry).toContain(call);
  const files = new Map([['main.tsx', entry.replace(call, `/* where to sign in */ ${call}`)]]);
  expect(run(files).failures, 'a closed comment read as open: a false alarm').toEqual([]);
});
