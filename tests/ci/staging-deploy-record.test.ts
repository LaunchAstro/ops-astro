// SPDX-License-Identifier: AGPL-3.0-only
// S0-6d: `S0-6 deploy recorded`, the record a staging deploy leaves. The
// fixtures are staging-deploy.fixture.ts; the pins and the service checks are
// in staging-deploy.test.ts.

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deploy } from '../../scripts/ops/deploy.ts';
import {
  definition,
  STAGED,
  BUILT,
  CANARY,
  scratch,
  effects,
  clean,
  store,
} from './staging-deploy.fixture.ts';

// ---- deploy recorded, and the artefact staging runs ------------------------

describe('S0-6 deploy recorded', () => {
  it('records the version, the artefact and the image id, and nothing from the environment', async () => {
    process.env['OPS_ASTRO_TOKEN'] = CANARY;
    try {
      const outcome = await deploy({ version: STAGED, store: store() }, effects(), clean);
      expect(outcome).toMatchObject({
        kind: 'deployed',
        record: {
          action: 'deploy recorded',
          version: STAGED,
          artefact: definition['x-ops-astro'].artefact.replace('{version}', STAGED),
          image: BUILT,
        },
      });
      expect(JSON.stringify(outcome)).not.toContain(CANARY);
      expect(JSON.stringify(outcome)).not.toContain(scratch);
    } finally {
      delete process.env['OPS_ASTRO_TOKEN'];
    }
  });

  it('never another build: a different stamp, no artefact or a dirty build is refused before anything is asked', async () => {
    const cases = [
      { version: STAGED, store: store(STAGED, 'fedcba987654') },
      { version: STAGED, store: join(scratch, 'no-store') },
      { version: `${STAGED}-dirty`, store: store() },
      { version: '../../etc', store: store() },
    ];
    for (const request of cases) {
      const watched = effects();
      // oxlint-disable-next-line no-await-in-loop -- each request on its own
      const outcome = await deploy(request, watched, clean);
      expect(outcome.kind, JSON.stringify(request)).toBe('refused');
      expect(watched.calls).toStrictEqual([]);
    }
  });

  imageIdCases();
});

function imageIdCases() {
  it('an image the build does not name by a full image id is refused before Compose is asked', async () => {
    for (const id of [
      '',
      'ops-astro-staging-app:latest',
      'sha256:abc',
      `sha256:${'a'.repeat(64)}\n`,
    ]) {
      const watched = effects({ buildImage: () => id });
      // oxlint-disable-next-line no-await-in-loop -- each id on its own
      const outcome = await deploy({ version: STAGED, store: store() }, watched, clean);
      expect(outcome.kind, id).toBe('failed');
      expect(watched.calls).not.toContain('up');
    }
  });
}
