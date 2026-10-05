// SPDX-License-Identifier: AGPL-3.0-only
//
// #497's trust boundary (ORCH117 OPS497TRUST, security read SEC-OPS-REBUILD-3c
// finding 1): root and the promoting user only. Whoever can write a folder on
// the path to production's link can move the link's folder away and put their
// own in its place, so the promotion walks from the link's folder up to `/`
// and refuses unless each one is a real folder (never a link), owned by root or
// the promoter, with no group or other write and no sticky bit. One fixture
// tree per refusal case; each refusal migrates nothing and points nothing.

import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { stampOutput } from '../../scripts/ops/build-output.ts';
import { artefactName, promote, type PromotionEffects } from '../../scripts/ops/promotion.ts';
import { untrustedChain } from '../../scripts/ops/served-copy.ts';
import { trustedTemp } from './promotion.fixture.ts';

const VERSION = '0123456789ab';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    // A fixture may have taken its own write away; give it back to remove it.
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

/** A trusted folder holding a store with one stamped artefact. */
function fixture(): { root: string; store: string } {
  const root = trustedTemp('ops-astro-trust-');
  roots.push(root);
  const store = join(root, 'store');
  const artefact = join(store, artefactName(VERSION));
  mkdirSync(join(artefact, 'static'), { recursive: true });
  writeFileSync(join(artefact, 'static', 'index.html'), 'the bytes tried on staging');
  stampOutput(artefact, VERSION);
  return { root, store };
}

function promoted(store: string, current: string) {
  const calls: string[] = [];
  const effects: PromotionEffects = {
    services: () => [
      { manager: 'docker', name: 'prod-api', running: false },
      { manager: 'docker', name: 'prod-auth', running: false },
    ],
    migrate: () => {
      calls.push('migrate');
      return true;
    },
    point: (link, served) => calls.push(`point ${link} -> ${served}`),
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
      current,
    },
    effects,
  );
  return { outcome, calls };
}

/** `<root>/<parent>/prod/current`, `prod/` private, `parent` given `mode`. */
function underParent(mode: number) {
  const { root, store } = fixture();
  const parent = join(root, 'parent');
  mkdirSync(join(parent, 'prod'), { recursive: true, mode: 0o755 });
  chmodSync(parent, mode);
  return { parent, prod: join(parent, 'prod'), store };
}

it.each([
  ['group-writable', 0o775, /can be written by others/u],
  ['other-writable (the shared store of the security read)', 0o777, /can be written by others/u],
  ['sticky, like /tmp', 0o1777, /sticky/u],
])('a %s parent of the link folder is refused, nothing migrated or pointed', (_name, mode, why) => {
  const { parent, prod, store } = underParent(mode);
  const { outcome, calls } = promoted(store, join(prod, 'current'));
  expect(outcome).toMatchObject({ kind: 'refused', reason: expect.stringMatching(why) });
  expect(outcome).toMatchObject({ reason: expect.stringContaining(parent) });
  expect(calls).toEqual([]);
  // Checked before anything is made beside the link.
  expect(existsSync(join(prod, 'served'))).toBe(false);
});

it('a parent reached through a link is refused, nothing migrated or pointed', () => {
  const { root, store } = fixture();
  mkdirSync(join(root, 'real', 'prod'), { recursive: true });
  symlinkSync(join(root, 'real'), join(root, 'alias'));
  const { outcome, calls } = promoted(store, join(root, 'alias', 'prod', 'current'));
  expect(outcome).toMatchObject({
    kind: 'refused',
    reason: expect.stringContaining(`${join(root, 'alias')} is a link`),
  });
  expect(calls).toEqual([]);
});

it('a folder on the path owned by neither root nor the promoter is refused', () => {
  const { root } = fixture();
  const prod = join(root, 'prod');
  mkdirSync(prod);
  const promoter = process.getuid?.() ?? 0;
  // The fixture's folders are this user's; to another promoting user they are foreign.
  expect(untrustedChain(prod, promoter)).toBeUndefined();
  expect(untrustedChain(prod, promoter + 1)).toBe(
    `${prod} belongs to a user other than root and the promoter`,
  );
});

it('a link folder that does not exist yet is refused before anything is made', () => {
  const { root, store } = fixture();
  const { outcome, calls } = promoted(store, join(root, 'not-yet', 'current'));
  expect(outcome).toMatchObject({
    kind: 'refused',
    reason: expect.stringContaining(`${join(root, 'not-yet')} is missing`),
  });
  expect(calls).toEqual([]);
});

it('a link named served, where the copies live, is refused', () => {
  const { root, store } = fixture();
  const { outcome, calls } = promoted(store, join(root, 'served'));
  expect(outcome).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/served/u) });
  expect(calls).toEqual([]);
});

it('the link pointed is the normalised path the walk checked, not the path as given', () => {
  const { root, store } = fixture();
  mkdirSync(join(root, 'prod'));
  const { outcome, calls } = promoted(store, `${join(root, 'prod')}/./x/../current`);
  expect(outcome.kind).toBe('promoted');
  expect(calls[1]).toMatch(new RegExp(`^point ${join(root, 'prod', 'current')} -> `, 'u'));
});

it('a fully trusted path is promoted', () => {
  const { parent, prod, store } = underParent(0o755);
  const { outcome, calls } = promoted(store, join(prod, 'current'));
  expect(outcome.kind).toBe('promoted');
  expect(calls).toEqual(['migrate', expect.stringContaining(join(parent, 'prod', 'served'))]);
});
