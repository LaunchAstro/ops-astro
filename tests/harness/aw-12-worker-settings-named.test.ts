// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12's credential scan plants its canary under every name the worker reads
// (`WORKER_SETTINGS`, `apps/worker/main.ts`), so a setting the worker reads and
// the list leaves out is a place the scan never looks. The batch 3 join brought
// main's heartbeat pacing (`OPS_HEARTBEAT_EVERY_MS`, `apps/worker/heartbeat.ts`)
// beside SL11's list; this holds the list to the names the worker's files read.

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { WORKER_SETTINGS } from '../../apps/worker/main.ts';

const READ_BY_THE_WORKER = ['apps/worker/main.ts', 'apps/worker/heartbeat.ts'];

it('AW-12 worker settings: the list names every setting the worker reads', () => {
  const named = READ_BY_THE_WORKER.flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/'(OPS_[A-Z_]+)'/gu)].map((match) => match[1]),
  );
  expect(named.length).toBeGreaterThan(0);
  expect([...new Set(named)].filter((name) => !WORKER_SETTINGS.includes(name as never))).toEqual(
    [],
  );
});
