// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-SPEED (#724): stub, so the tests fail on what they assert. The check follows.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PREFIX = 'gh-readonly-queue/';

export function queueTips(_text) {
  return new Set();
}

export function pullHead(_payload) {
  return null;
}

export function refusal(_head, _tips) {
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(0);
}
