// SPDX-License-Identifier: AGPL-3.0-only
//
// How a test here runs a browser leg. The tests run under jsdom, so each leg
// is a Node script beside this file: it draws in the pinned browser, prints
// its report as JSON and exits non-zero when it cannot draw (no browser, no
// app), which fails the test.

import { spawnSync } from 'node:child_process';
import { URL as NodeURL } from 'node:url';
import { expect } from 'vitest';

/** Runs the leg `script` (a file name in this folder) and returns the report it printed. */
export function runLeg<T>(script: string): T {
  const path = new NodeURL(script, import.meta.url).pathname;
  const run = spawnSync(process.execPath, [path], { encoding: 'utf8', timeout: 900_000 });
  expect(run.status, run.stderr.slice(-2000)).toBe(0);
  return JSON.parse(run.stdout) as T;
}
