// SPDX-License-Identifier: AGPL-3.0-only
//
// #497, security read SEC-OPS-REBUILD-3: what production serves is a real copy
// of the validated bytes. A store artefact holding a symlink is refused (a
// copied link would still serve the store's bytes); a `served/<digest>` that
// is a link, planted before the promotion, is refused; and the copy is
// readable by a service running as another user, as the artefact was.

import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { stampOutput } from '../../scripts/ops/build-output.ts';
import {
  artefactName,
  promote,
  storedArtefact,
  type PromotionEffects,
} from '../../scripts/ops/promotion.ts';

const VERSION = '0123456789ab';
const stores: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) rmSync(store, { recursive: true, force: true });
});

/** A store holding one stamped artefact; `extra` adds to it before the stamp. */
function storeWith(extra: (artefact: string) => void = () => {}): string {
  const store = mkdtempSync(join(tmpdir(), 'ops-astro-frozen-'));
  stores.push(store);
  const artefact = join(store, artefactName(VERSION));
  mkdirSync(join(artefact, 'static'), { recursive: true });
  writeFileSync(join(artefact, 'static', 'index.html'), 'the bytes tried on staging');
  extra(artefact);
  stampOutput(artefact, VERSION);
  return store;
}

function promoted(store: string): { outcome: ReturnType<typeof promote>; pointed: string[] } {
  const pointed: string[] = [];
  const effects: PromotionEffects = {
    services: () => [
      { manager: 'docker', name: 'prod-api', running: false },
      { manager: 'docker', name: 'prod-auth', running: false },
    ],
    migrate: () => true,
    point: (_link, served) => pointed.push(served),
    start: () => {},
  };
  const outcome = promote(
    {
      version: VERSION,
      store,
      line: 'Tried this artefact on staging.',
      dryRun: false,
      api: { manager: 'docker', name: 'prod-api' },
      auth: { manager: 'docker', name: 'prod-auth' },
      current: join(store, 'current'),
    },
    effects,
  );
  return { outcome, pointed };
}

it('a store artefact holding a symlink is refused, and nothing is promoted', () => {
  const store = storeWith((artefact) => {
    writeFileSync(join(artefact, 'static', 'real.html'), 'same bytes');
    writeFileSync(join(artefact, 'static', 'link.html'), 'same bytes');
  });
  // After the stamp, a store writer swaps a file for a link to the same bytes.
  const artefact = join(store, artefactName(VERSION));
  rmSync(join(artefact, 'static', 'link.html'));
  symlinkSync('real.html', join(artefact, 'static', 'link.html'));
  expect(storedArtefact(VERSION, store)).toMatch(/not a regular file or folder/u);
  const { outcome, pointed } = promoted(store);
  expect(outcome.kind).toBe('refused');
  expect(pointed).toEqual([]);
});

it('a served copy planted as a link before the promotion is refused, and nothing is promoted', () => {
  const store = storeWith();
  const selected = storedArtefact(VERSION, store);
  if (typeof selected === 'string') throw new Error(selected);
  mkdirSync(join(store, 'served'));
  symlinkSync(selected.path, join(store, 'served', selected.digest.slice('sha256:'.length)));
  const { outcome, pointed } = promoted(store);
  expect(outcome).toMatchObject({ kind: 'refused' });
  expect(pointed).toEqual([]);
});

it('the served copy is readable by a service running as another user', () => {
  const { outcome } = promoted(storeWith());
  if (outcome.kind !== 'promoted') throw new Error(`not promoted: ${JSON.stringify(outcome)}`);
  expect(statSync(outcome.artefactPath).mode & 0o055).toBe(0o055);
  expect(statSync(join(outcome.artefactPath, 'static')).mode & 0o055).toBe(0o055);
  expect(statSync(join(outcome.artefactPath, 'static', 'index.html')).mode & 0o044).toBe(0o044);
});
