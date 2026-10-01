// SPDX-License-Identifier: AGPL-3.0-only
// Review proof (REVIEW-MAIN-B1 p12-2): the promotion points production's link
// at `join(store, name)` as given. promote.mjs passes `--artefacts` through
// unresolved and makes the link with `symlinkSync(artefact, link.promoting)`,
// which stores the target text as it is; a relative target is resolved from
// the link's own folder, not the operator's working folder. So
// `--artefacts store --current /srv/prod/current` migrates production, then
// leaves `current` pointing at /srv/prod/store/..., which is not there, and
// starts the auth server and the API on it.
//
// The step's decisions are watched through `promote`, and the link is made
// exactly as promote.mjs's `point` makes it.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { promote, type PromotionEffects } from '../../scripts/ops/promotion.ts';
import { LINE, named, STAGED, store } from '../ci/promotion.fixture.ts';

const production = mkdtempSync(join(tmpdir(), 'p12-2-prod-'));
afterAll(() => rmSync(production, { recursive: true, force: true }));

it('p12-2 a promotion run with a relative --artefacts leaves production linked to the artefact', () => {
  const absolute = store({ [named(STAGED)]: STAGED });
  // The operator names the store relative to where they stand, as any path argument may be.
  const given = relative(process.cwd(), absolute);
  // Deeper than any working folder, so the relative target cannot climb out of it by chance.
  const folder = join(production, 'srv', 'ops-astro', 'production', 'a', 'b', 'c', 'd', 'e');
  mkdirSync(folder, { recursive: true });
  const current = join(folder, 'current');
  const effects: PromotionEffects = {
    services: () => [
      { manager: 'docker', name: 'prod-api', running: false },
      { manager: 'docker', name: 'prod-auth', running: false },
    ],
    migrate: () => true,
    // promote.mjs's point, line for line.
    point: (link, artefact) => {
      const next = `${link}.promoting`;
      rmSync(next, { force: true });
      symlinkSync(artefact, next);
      renameSync(next, link);
    },
    start: () => {},
  };
  const outcome = promote(
    {
      version: STAGED,
      store: given,
      line: LINE,
      dryRun: false,
      api: { manager: 'docker', name: 'prod-api' },
      auth: { manager: 'docker', name: 'prod-auth' },
      current,
    },
    effects,
  );
  expect(outcome.kind).toBe('promoted');
  expect(
    existsSync(current),
    `DEFECT p12-2: after migrating, the promotion pointed production's link at the relative ${join(given, named(STAGED))}, which resolves from the link's own folder and dangles`,
  ).toBe(true);
  expect(realpathSync(current)).toBe(realpathSync(join(absolute, named(STAGED))));
});
