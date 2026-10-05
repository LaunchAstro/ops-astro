// SPDX-License-Identifier: AGPL-3.0-only
//
// #497, security read SEC-OPS-REBUILD-3: what production serves is a real copy
// of the validated bytes. A store artefact holding a symlink is refused (a
// copied link would still serve the store's bytes); a `served/<digest>` that
// is a link, planted before the promotion, is refused; and the copy is
// readable by a service running as another user, as the artefact was. The
// copies live beside production's link, in a folder only the promoting user
// may write (round 2): a store another user writes never holds them.

import {
  chmodSync,
  cpSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { stampOutput } from '../../scripts/ops/build-output.ts';
import {
  artefactName,
  promote,
  storedArtefact,
  type PromotionEffects,
} from '../../scripts/ops/promotion.ts';
import { trustedTemp } from './promotion.fixture.ts';

const VERSION = '0123456789ab';
const stores: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) rmSync(store, { recursive: true, force: true });
});

/** A store holding one stamped artefact; `extra` adds to it before the stamp. */
function storeWith(extra: (artefact: string) => void = () => {}): string {
  const store = trustedTemp('ops-astro-frozen-');
  stores.push(store);
  const artefact = join(store, artefactName(VERSION));
  mkdirSync(join(artefact, 'static'), { recursive: true });
  writeFileSync(join(artefact, 'static', 'index.html'), 'the bytes tried on staging');
  extra(artefact);
  stampOutput(artefact, VERSION);
  return store;
}

function promoted(
  store: string,
  current = join(store, 'current'),
  migrate = (): boolean => true,
  link = false,
): { outcome: ReturnType<typeof promote>; pointed: string[] } {
  const pointed: string[] = [];
  const effects: PromotionEffects = {
    services: () => [
      { manager: 'docker', name: 'prod-api', running: false },
      { manager: 'docker', name: 'prod-auth', running: false },
    ],
    migrate,
    point: (at, served) => {
      pointed.push(served);
      if (link) symlinkSync(served, at);
    },
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

it('a served copy planted as a link before the promotion is replaced by a real copy', () => {
  const store = storeWith();
  const selected = storedArtefact(VERSION, store);
  if (typeof selected === 'string') throw new Error(selected);
  mkdirSync(join(store, 'served'));
  const planted = join(store, 'served', selected.digest.slice('sha256:'.length));
  symlinkSync(selected.path, planted);
  const { outcome, pointed } = promoted(store);
  expect(outcome).toMatchObject({ kind: 'promoted', artefactPath: planted });
  expect(lstatSync(planted).isDirectory()).toBe(true);
  expect(pointed).toEqual([planted]);
});

/** A copy of the artefact already at `served/<digest>` before the promotion, as `shape` leaves it. */
function cached(store: string, shape: (copy: string, artefact: string) => void): string {
  const selected = storedArtefact(VERSION, store);
  if (typeof selected === 'string') throw new Error(selected);
  mkdirSync(join(store, 'served'), { mode: 0o755 });
  const copy = join(store, 'served', selected.digest.slice('sha256:'.length));
  cpSync(selected.path, copy, { recursive: true });
  shape(copy, selected.path);
  return copy;
}

it('a copy already served with group or other write is copied again, so production takes none', () => {
  const store = storeWith();
  const copy = cached(store, (at) => chmodSync(join(at, 'static', 'index.html'), 0o666));
  const current = join(store, 'current');
  const { outcome } = promoted(store, current, () => true, true);
  expect(outcome).toMatchObject({ kind: 'promoted', artefactPath: copy });
  for (const path of ['', 'static', join('static', 'index.html')]) {
    expect(statSync(join(current, path)).mode & 0o022, path).toBe(0);
  }
});

it('a copy already served that shares a file with the store is copied again, so a later store write changes nothing served', () => {
  const store = storeWith();
  cached(store, (at, artefact) => {
    rmSync(join(at, 'static', 'index.html'));
    linkSync(join(artefact, 'static', 'index.html'), join(at, 'static', 'index.html'));
  });
  const current = join(store, 'current');
  const { outcome } = promoted(store, current, () => true, true);
  expect(outcome.kind).toBe('promoted');
  writeFileSync(join(store, artefactName(VERSION), 'static', 'index.html'), 'a store write');
  expect(readFileSync(join(current, 'static', 'index.html'), 'utf8')).toBe(
    'the bytes tried on staging',
  );
});

/** Every folder from `top` down to `file` that another user cannot search, and `file` if they cannot read it. */
function closedToOthers(top: string, file: string): string[] {
  const closed = statSync(file).mode & 0o004 ? [] : [file];
  for (let at = dirname(file); ; at = dirname(at)) {
    if ((statSync(at).mode & 0o001) === 0) closed.push(relative(top, at) || '.');
    if (at === top) return closed;
  }
}

it('a promoter whose umask is 077 still serves a copy another user can read', () => {
  const store = storeWith();
  chmodSync(store, 0o755);
  const artefact = join(store, artefactName(VERSION));
  for (const folder of [artefact, join(artefact, 'static')]) chmodSync(folder, 0o755);
  const before = process.umask(0o077);
  let outcome;
  try {
    ({ outcome } = promoted(store));
  } finally {
    process.umask(before);
  }
  if (outcome.kind !== 'promoted') throw new Error(`not promoted: ${JSON.stringify(outcome)}`);
  expect(closedToOthers(store, join(outcome.artefactPath, 'static', 'index.html'))).toEqual([]);
});

it("another user can search every folder from production's folder to the served page, and read it", () => {
  // The folders above production's link are the operator's (the runbook names
  // the services' search there); this fixture's own temp folder is private.
  const store = storeWith();
  chmodSync(store, 0o755);
  const { outcome } = promoted(store);
  if (outcome.kind !== 'promoted') throw new Error(`not promoted: ${JSON.stringify(outcome)}`);
  expect(closedToOthers(store, join(outcome.artefactPath, 'static', 'index.html'))).toEqual([]);
});

it('a production folder others can write is refused, and nothing is promoted', () => {
  const store = storeWith();
  const home = trustedTemp('ops-astro-frozen-home-');
  stores.push(home);
  chmodSync(home, 0o777);
  const { outcome, pointed } = promoted(store, join(home, 'current'));
  expect(outcome).toMatchObject({
    kind: 'refused',
    reason: expect.stringMatching(/written by others/u),
  });
  expect(pointed).toEqual([]);
});

it('a store artefact that is itself a link is refused', () => {
  const store = storeWith();
  const artefact = join(store, artefactName(VERSION));
  renameSync(artefact, join(store, 'elsewhere'));
  symlinkSync(join(store, 'elsewhere'), artefact);
  expect(storedArtefact(VERSION, store)).toMatch(/no artefact/u);
});

it('a link put at the served copy during the migration fails the promotion', () => {
  const store = storeWith();
  const selected = storedArtefact(VERSION, store);
  if (typeof selected === 'string') throw new Error(selected);
  const served = join(store, 'served', selected.digest.slice('sha256:'.length));
  const { outcome, pointed } = promoted(store, join(store, 'current'), () => {
    renameSync(served, `${served}-moved`);
    symlinkSync(`${served}-moved`, served);
    return true;
  });
  expect(outcome.kind).toBe('failed');
  expect(pointed).toEqual([]);
});

it('the served copy takes no group or other write, whatever the artefact had', () => {
  const store = storeWith();
  const artefact = join(store, artefactName(VERSION));
  chmodSync(artefact, 0o777);
  chmodSync(join(artefact, 'static'), 0o777);
  chmodSync(join(artefact, 'static', 'index.html'), 0o666);
  const { outcome } = promoted(store);
  if (outcome.kind !== 'promoted') throw new Error(`not promoted: ${JSON.stringify(outcome)}`);
  for (const path of ['', 'static', join('static', 'index.html')]) {
    expect(statSync(join(outcome.artefactPath, path)).mode & 0o022, path).toBe(0);
  }
});
