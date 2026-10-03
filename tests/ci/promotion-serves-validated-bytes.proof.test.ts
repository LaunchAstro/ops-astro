// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { outputDigest, recordedStamp, stampOutput } from '../../scripts/ops/build-output.ts';
import { artefactName, promote } from '../../scripts/ops/promotion.ts';

it('promotion serves the validated bytes despite a store write during migration', () => {
  const store = mkdtempSync(join(tmpdir(), 'sol-ow065-store-'));
  try {
    const version = '0123456789ab';
    const artefact = join(store, artefactName(version));
    mkdirSync(artefact);
    writeFileSync(join(artefact, 'index.html'), 'the bytes tried on staging');
    stampOutput(artefact, version);
    const stagedDigest = outputDigest(artefact);
    expect(recordedStamp(artefact).digest).toBe(stagedDigest);
    let served: string | undefined;
    const outcome = promote(
      {
        version,
        store,
        line: 'Tried this artefact on staging.',
        dryRun: false,
        api: { manager: 'docker', name: 'prod-api' },
        auth: { manager: 'launchd', name: 'prod-auth' },
        current: join(store, 'current'),
      },
      {
        services: () => [
          { manager: 'docker', name: 'prod-api', running: false },
          { manager: 'launchd', name: 'prod-auth', running: false },
        ],
        migrate: () => {
          // Another process can write the mutable store while migrations run.
          writeFileSync(join(artefact, 'index.html'), 'unvalidated replacement bytes');
          return true;
        },
        point: (_link, selected) => {
          served = selected;
        },
        start: () => {},
      },
    );
    expect(readFileSync(join(artefact, 'index.html'), 'utf8')).toBe(
      'unvalidated replacement bytes',
    );
    // Refusal is safe; a promotion must serve the original validated digest.
    if (outcome.kind === 'promoted') {
      expect(served).toBeDefined();
      expect(outputDigest(served!)).toBe(stagedDigest);
    } else {
      expect(served).toBeUndefined();
    }
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});
