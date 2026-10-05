// SPDX-License-Identifier: AGPL-3.0-only
//
// Security read SEC-OPS-REBUILD-3i (#497): the fresh served copy stays closed
// to other users until every entry in it has its served mode; an entry that is
// not the promoter's is refused; and the step that replaces an earlier copy
// keeps that copy when the new one cannot go in, keeps a good answer when the
// cleanup fails, and leaves no temporary copy when it cannot start. The disk
// faults are stood in for by wrapping node:fs, one fault per case.

import * as fs from 'node:fs';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { stampOutput } from '../../scripts/ops/build-output.ts';
import { artefactName, promote, storedArtefact } from '../../scripts/ops/promotion.ts';
import { trustedTemp } from './promotion.fixture.ts';

/** The one fault a case turns on; each stand-in passes through when its fault is off. */
const fault = vi.hoisted(() => ({
  /** Paths whose lstat answers another owner. */
  foreign: [] as RegExp[],
  /** The rename of a fresh copy into its served name fails. */
  renameIn: false,
  /** Removing a temporary folder fails. */
  remove: false,
  /** Making the folder an earlier copy is moved into fails. */
  aside: false,
  /** For each mode set on an entry inside a fresh copy, the copy folder's other-user bits then. */
  openWhileSet: [] as number[],
}));
afterEach(() => {
  fault.foreign = [];
  fault.renameIn = false;
  fault.remove = false;
  fault.aside = false;
  fault.openWhileSet = [];
});

vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  const inside = /^(.*\/\.copy-[^/]+)\/./u;
  return {
    ...real,
    lstatSync: ((path: string, options?: never) => {
      const entry = real.lstatSync(path, options);
      if (!fault.foreign.some((pattern) => pattern.test(String(path)))) return entry;
      return Object.assign(Object.create(Object.getPrototypeOf(entry) as object), entry, {
        uid: entry.uid + 1,
      });
    }) as typeof real.lstatSync,
    chmodSync: (path: string, mode: number) => {
      const copy = inside.exec(String(path))?.[1];
      if (copy !== undefined) fault.openWhileSet.push(real.lstatSync(copy).mode & 0o077);
      real.chmodSync(path, mode);
    },
    renameSync: (from: string, to: string) => {
      if (fault.renameIn && /\/\.copy-[^/]+$/u.test(String(from))) {
        throw Object.assign(new Error('i/o error'), { code: 'EIO' });
      }
      real.renameSync(from, to);
    },
    rmSync: ((path: string, options?: never) => {
      if (fault.remove) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      real.rmSync(path, options);
    }) as typeof real.rmSync,
    mkdtempSync: ((prefix: string, options?: never) => {
      if (fault.aside && prefix.endsWith('.before-')) {
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      }
      return real.mkdtempSync(prefix, options);
    }) as typeof real.mkdtempSync,
  };
});

const VERSION = '0123456789ab';
const PAGE = 'the bytes tried on staging';
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    fs.chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

/** A store with one stamped artefact and a production folder beside it. */
function world(page = PAGE): { store: string; current: string; hex: string } {
  const root = trustedTemp('ops-astro-copy-replace-');
  roots.push(root);
  const store = join(root, 'store');
  const artefact = join(store, artefactName(VERSION));
  mkdirSync(join(artefact, 'static'), { recursive: true });
  writeFileSync(join(artefact, 'static', 'index.html'), page);
  stampOutput(artefact, VERSION);
  mkdirSync(join(root, 'prod'));
  const selected = storedArtefact(VERSION, store);
  if (typeof selected === 'string') throw new Error(selected);
  return {
    store,
    current: join(root, 'prod', 'current'),
    hex: selected.digest.slice('sha256:'.length),
  };
}

function promoted(
  store: string,
  current: string,
): { outcome: ReturnType<typeof promote>; calls: string[] } {
  const calls: string[] = [];
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
  return { outcome, calls };
}

/** An earlier copy at served/<hex>, holding `page`. */
function earlier(current: string, hex: string, page: string): string {
  const copy = join(current, '..', 'served', hex);
  mkdirSync(join(copy, 'static'), { recursive: true });
  writeFileSync(join(copy, 'static', 'index.html'), page);
  return copy;
}

it('a fresh copy stays closed to other users until every entry in it has its served mode', () => {
  const { store, current } = world();
  const artefact = join(store, artefactName(VERSION));
  fs.chmodSync(join(artefact, 'static'), 0o777);
  fs.chmodSync(join(artefact, 'static', 'index.html'), 0o666);
  const before = process.umask(0);
  let outcome;
  try {
    ({ outcome } = promoted(store, current));
  } finally {
    process.umask(before);
  }
  expect(outcome.kind).toBe('promoted');
  expect(fault.openWhileSet.length).toBeGreaterThan(0);
  expect(fault.openWhileSet.filter((bits) => bits !== 0)).toEqual([]);
});

it("a fresh copy holding an entry that is not the promoter's is refused, and nothing is migrated", () => {
  const { store, current } = world();
  fault.foreign = [/\/\.copy-[^/]+\/static\/index\.html$/u];
  const { outcome, calls } = promoted(store, current);
  expect(outcome).toMatchObject({
    kind: 'refused',
    reason: expect.stringMatching(/static\/index\.html is not the promoter's/u),
  });
  expect(calls).toEqual([]);
});

it("an earlier copy that is not the promoter's is refused by name, not replaced, and nothing is migrated", () => {
  const { store, current, hex } = world();
  const copy = earlier(current, hex, PAGE);
  fault.foreign = [new RegExp(`/served/${hex}$`, 'u')];
  const { outcome, calls } = promoted(store, current);
  expect(outcome).toMatchObject({
    kind: 'refused',
    reason: expect.stringContaining(
      `${copy.replace('/prod/../', '/')} is there and is not the promoter's`,
    ),
  });
  expect(calls).toEqual([]);
});

it('a fresh copy that cannot take its served name leaves the earlier copy in place', () => {
  const { store, current, hex } = world();
  const copy = earlier(current, hex, 'the earlier copy');
  fault.renameIn = true;
  const { outcome, calls } = promoted(store, current);
  expect(outcome).toMatchObject({ kind: 'refused', reason: expect.stringContaining('EIO') });
  expect(calls).toEqual([]);
  expect(readFileSync(join(copy, 'static', 'index.html'), 'utf8')).toBe('the earlier copy');
});

it('a refused replacement leaves the earlier copy with its own modes, so it reads as before', () => {
  const { store, current, hex } = world();
  const copy = earlier(current, hex, 'the earlier copy');
  for (const folder of [copy, join(copy, 'static')]) fs.chmodSync(folder, 0o755);
  fs.chmodSync(join(copy, 'static', 'index.html'), 0o644);
  fault.renameIn = true;
  const { outcome, calls } = promoted(store, current);
  expect(outcome.kind).toBe('refused');
  expect(calls).toEqual([]);
  expect(fs.statSync(copy).mode & 0o7777).toBe(0o755);
  expect(fs.statSync(join(copy, 'static')).mode & 0o7777).toBe(0o755);
});

it('a cleanup that fails after the copy is in place still promotes', () => {
  const { store, current } = world();
  fault.remove = true;
  const { outcome, calls } = promoted(store, current);
  expect(outcome.kind).toBe('promoted');
  expect(calls).toEqual(['migrate', 'point']);
});

it('a replace step that cannot start leaves no temporary copy behind', () => {
  const { store, current, hex } = world();
  earlier(current, hex, PAGE);
  fault.aside = true;
  const { outcome, calls } = promoted(store, current);
  expect(outcome).toMatchObject({ kind: 'refused', reason: expect.stringContaining('ENOSPC') });
  expect(calls).toEqual([]);
  expect(readdirSync(join(current, '..', 'served')).filter((name) => name.startsWith('.'))).toEqual(
    [],
  );
});
