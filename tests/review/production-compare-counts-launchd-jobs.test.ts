// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { unitOf } from '../../scripts/ops/deploy.ts';
// @ts-expect-error -- the service report is the machine's plain JavaScript module
import { compare } from '../../scripts/ops/service-report.mjs';

it('production compare detects a restarted launchd job outside the Compose unit', () => {
  const job = {
    manager: 'launchd',
    name: 'ops-astro-nightly-backup',
    running: true,
    started: '411',
    image: null,
    ports: [],
    config: null,
  };
  const before = JSON.stringify({ services: [job] });
  const after = JSON.stringify({ services: [{ ...job, started: '412' }] });
  const compared = compare(before, after, unitOf('production'));
  expect(compared.unchanged, compared.report).toBe(false);
  expect(compared.report).toContain('RESTARTED launchd ops-astro-nightly-backup');
});
