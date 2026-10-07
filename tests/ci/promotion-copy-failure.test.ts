// SPDX-License-Identifier: AGPL-3.0-only
//
// Security read SEC-OPS-REBUILD-3e low 2: a copy that fails for a reason of
// the disk's own (here a full disk) is refused with that reason, not blamed
// on a store writer: the artefact still holds its digest. Nothing is migrated.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { stampOutput } from '../../scripts/ops/build-output.ts';
import { artefactName, promote } from '../../scripts/ops/promotion.ts';
import { trustedTemp } from './promotion.fixture.ts';
import { rmSync } from 'node:fs';

vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  cpSync: () => {
    throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  },
}));

const VERSION = '0123456789ab';
const root = trustedTemp('ops-astro-copy-failure-');
afterAll(() => rmSync(root, { recursive: true, force: true }));

it('a copy the disk refuses is refused with the disk reason, not as a changed artefact', () => {
  const store = join(root, 'store');
  const artefact = join(store, artefactName(VERSION));
  mkdirSync(join(artefact, 'static'), { recursive: true });
  writeFileSync(join(artefact, 'static', 'index.html'), 'the bytes tried on staging');
  stampOutput(artefact, VERSION);
  mkdirSync(join(root, 'prod'));
  const calls: string[] = [];
  const outcome = promote(
    {
      version: VERSION,
      store,
      line: 'Tried this artefact on staging.',
      dryRun: false,
      api: { manager: 'docker', name: 'prod-api' },
      auth: { manager: 'docker', name: 'prod-auth' },
      current: join(root, 'prod', 'current'),
    },
    {
      services: () => [
        { manager: 'docker', name: 'prod-api', running: false },
        { manager: 'docker', name: 'prod-auth', running: false },
      ],
      migrate: () => {
        calls.push('migrate');
        return true;
      },
      point: () => calls.push('point'),
      start: () => {},
    },
  );
  expect(outcome).toMatchObject({
    kind: 'refused',
    reason: expect.stringContaining(`${artefactName(VERSION)} could not be copied: ENOSPC`),
  });
  expect(calls).toEqual([]);
});
