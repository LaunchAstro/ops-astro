// SPDX-License-Identifier: AGPL-3.0-only
//
// The parity check probes every API route with a stub database (#2462). A route that faults
// under the probe answers 500 and printed its error while the check carried on, so a probe
// that judged nothing could still pass. The stub now answers what routes ask of it, and a
// probed route that faults is a parity failure.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';
// @ts-expect-error -- the parity runner is a plain JavaScript module
import { probeFailures, probeRoutes } from '../../scripts/command-parity.mjs';

const root = join(import.meta.dirname, '../..');

interface Probed {
  readonly routed: Map<string, unknown>;
  readonly faulted: readonly { readonly path: string; readonly status: number }[];
}

it('--check prints no error and exits 0 on this tree', () => {
  const checked = spawnSync(process.execPath, ['scripts/command-parity.mjs', '--check'], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(checked.stderr).toBe('');
  expect(checked.status).toBe(0);
}, 60_000);

it('a route that faults under the probe is named as a parity failure', async () => {
  // A database with nothing on it: the operations read asks it whether this business
  // operates the installation, so that route faults.
  const probed = (await probeRoutes({})) as Probed;
  const faulted = probed.faulted.map((one) => one.path);
  expect(faulted).toContain('/api/b/b/operations/read');
  expect(probeFailures(probed)).toContain(
    'the route /api/b/b/operations/read faulted under the parity probe (500)',
  );
}, 60_000);
