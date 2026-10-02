// SPDX-License-Identifier: AGPL-3.0-only
//
// A hung step holds its job's runner, and a required job holds the merge-queue
// group, until GitHub's own limit of 360 minutes. On 1 October a browser
// install hung for 37 minutes in a group's 'local checks' with nothing to stop
// it. Every job in the workflows behind the required checks therefore names
// its own limit, set above its slowest green run.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');

/** Every job under `jobs:` in a workflow, keyed by its id. */
function jobs(workflow: string): Map<string, string> {
  const text = readFileSync(join(ROOT, '.github/workflows', workflow), 'utf8');
  const body = text.slice(text.search(/^jobs:$/mu));
  const parts = body.split(/^(?= {2}[\w-]+:$)/mu).slice(1);
  return new Map(parts.map((block) => [block.trim().split(':')[0] ?? '', block]));
}

it('every job behind the required checks gives its runner back at its own timeout', () => {
  const untimed = ['ci.yml', 'review-evidence.yml'].flatMap((workflow) =>
    [...jobs(workflow)]
      .filter(([, block]) => !/^ {4}timeout-minutes: [1-9]\d*$/mu.test(block))
      .map(([id]) => `${workflow} ${id}`),
  );
  expect(untimed).toEqual([]);
});
