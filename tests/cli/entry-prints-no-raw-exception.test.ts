// SPDX-License-Identifier: AGPL-3.0-only
//
// The process entry, `run`, answers a throw nothing else expected with one
// fixed line, `cli: internal fault`, and exit 4: never the error's own text
// or stack, which can carry what the command line was handling.

import { expect, it } from 'vitest';
import { run } from '../../apps/cli/main.ts';
import { holds } from './verb-lines.ts';

it('an unexpected throw prints the fixed fault line and exits 4', async () => {
  const canary = 'unexpected-throw-canary';
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(
    ['login', '--env', 'sandbox', '--email', 'ada@example.test'],
    {},
    {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      stdin: async () => await Promise.reject(new Error(`stdin broke ${canary}`)),
    },
  );
  expect(code).toBe(4);
  expect(err).toStrictEqual(['cli: internal fault']);
  expect(out).toStrictEqual([]);
  expect(holds(canary, ...out, ...err)).toBe(false);
});
