// SPDX-License-Identifier: AGPL-3.0-only
//
// I5 (docs/plan/sandbox-contract.md, section 3) as a closed grammar:
// `package-lock.json` read with the strict JSON parser, `lockfileVersion`
// exactly 3, a `package.json` with no `packageManager` field, and every
// non-root entry keyed `node_modules/<name>` (nested any depth), `<name>` in
// npm's name grammar, with a `sha512` integrity and a `resolved` URL spelt
// exactly from its own name and version: the public registry's tarball, or
// GitHub Packages' download under a scope the site record lists. An alias
// (`name` field), a `link` entry or any other form is a refusal.

import { expect, it } from 'vitest';
import {
  checkLockfile as checkBytes,
  LOCKFILE_CAP,
} from '../../packages/core-sandbox/src/lockfile.ts';

type Entry = Record<string, unknown>;
const asBytes = (file: string | Uint8Array) =>
  typeof file === 'string' ? new TextEncoder().encode(file) : file;
const checkLockfile = (
  packageJson: string | Uint8Array,
  lockfile: string | Uint8Array,
  scopes: readonly string[],
) => checkBytes(asBytes(packageJson), asBytes(lockfile), scopes);
const refused = (why: string) => ({ ok: false, reason: 'lockfile refused', why });
const SHA512 = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const HEX40 = 'a'.repeat(40);
const registry = (name: string, version: string): Entry => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name.replace(/^@[^/]+\//u, '')}-${version}.tgz`,
  integrity: SHA512,
});
const github = (name: string, version: string): Entry => ({
  version,
  resolved: `https://npm.pkg.github.com/download/${name}/${version}/${HEX40}`,
  integrity: SHA512,
});
const PACKAGES: Record<string, Entry> = {
  '': { name: 'site', version: '1.0.0', dependencies: { astro: '5.1.0' } },
  'node_modules/astro': registry('astro', '5.1.0'),
  'node_modules/@astrojs/compiler': registry('@astrojs/compiler', '2.10.3'),
  'node_modules/astro/node_modules/vite': { ...registry('vite', '6.0.1'), dev: true },
  'node_modules/@agency/theme': github('@agency/theme', '0.4.0-beta.1'),
};
const PACKAGE_JSON = JSON.stringify({ name: 'site', version: '1.0.0', private: true });
const lock = (packages: Record<string, unknown> = PACKAGES, version: unknown = 3) =>
  JSON.stringify({
    name: 'site',
    version: '1.0.0',
    lockfileVersion: version,
    requires: true,
    packages,
  });
const check = (packages?: Record<string, unknown>) =>
  checkLockfile(PACKAGE_JSON, lock(packages), ['@agency']);
const withEntry = (key: string, entry: Entry) => check({ ...PACKAGES, [key]: entry });

it('accepts registry and listed-scope GitHub entries, nested at any depth', () => {
  expect(check()).toEqual({ ok: true });
});

it('reads lockfileVersion 3 only, as a number', () => {
  for (const version of [1, 2, 4, '3', 3.0001, null]) {
    expect(
      checkLockfile(PACKAGE_JSON, lock(PACKAGES, version), ['@agency']),
      String(version),
    ).toEqual(refused('lockfile version'));
  }
});

it('refuses a package.json naming a package manager', () => {
  const pinned = JSON.stringify({ name: 'site', packageManager: 'pnpm@9.0.0' });
  expect(checkLockfile(pinned, lock(), ['@agency'])).toEqual(refused('package manager'));
});

it('refuses either file when the strict JSON parser does', () => {
  expect(checkLockfile(PACKAGE_JSON, `${lock()} x`, [])).toEqual(refused('json syntax'));
  expect(checkLockfile('{"a":1,"a":2}', lock(), [])).toEqual(refused('duplicate key'));
});

it('refuses an integrity that is missing, weaker than sha512, or not one well-formed hash', () => {
  const entry = registry('astro', '5.1.0');
  for (const integrity of [
    undefined,
    `sha1-${Buffer.alloc(20).toString('base64')}`,
    `sha256-${Buffer.alloc(32).toString('base64')}`,
    `sha512-${Buffer.alloc(63).toString('base64')}`,
    `${SHA512} sha1-${Buffer.alloc(20).toString('base64')}`,
    `SHA512-${Buffer.alloc(64).toString('base64')}`,
    `sha512-${'!'.repeat(88)}`,
  ]) {
    expect(withEntry('node_modules/astro', { ...entry, integrity }), String(integrity)).toEqual(
      refused('lockfile integrity'),
    );
  }
});

it('refuses a resolved URL that is not exactly one of the two forms for its own name and version', () => {
  const at = (resolved: unknown) =>
    withEntry('node_modules/astro', { ...registry('astro', '5.1.0'), resolved });
  for (const resolved of [
    undefined,
    'http://registry.npmjs.org/astro/-/astro-5.1.0.tgz',
    'https://registry.yarnpkg.com/astro/-/astro-5.1.0.tgz',
    'https://registry.npmjs.org/astro/-/astro-5.1.1.tgz',
    'https://registry.npmjs.org/astra/-/astra-5.1.0.tgz',
    'https://registry.npmjs.org/astro/-/astro-5.1.0.tgz?x=1',
    'https://registry.npmjs.org/astro/-/astro-5.1.0.tgz#x',
    'https://registry.npmjs.org:443/astro/-/astro-5.1.0.tgz',
    'https://REGISTRY.npmjs.org/astro/-/astro-5.1.0.tgz',
    'https://registry.npmjs.org/astro/-/../astro-5.1.0.tgz',
    'git+ssh://git@example.invalid/withastro/astro.git#abc',
    'file:../astro',
    `https://npm.pkg.github.com/download/astro/5.1.0/${HEX40}`,
  ]) {
    expect(at(resolved), String(resolved)).toEqual(refused('lockfile resolved'));
  }
});

it('takes GitHub Packages only under a listed scope, with a 40-hex final segment', () => {
  const key = 'node_modules/@agency/theme';
  const other = { ...github('@other/theme', '0.4.0-beta.1') };
  expect(withEntry('node_modules/@other/theme', other)).toEqual(refused('lockfile resolved'));
  for (const tail of ['A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), `${'a'.repeat(39)}g`]) {
    const resolved = `https://npm.pkg.github.com/download/@agency/theme/0.4.0-beta.1/${tail}`;
    expect(withEntry(key, { ...github('@agency/theme', '0.4.0-beta.1'), resolved }), tail).toEqual(
      refused('lockfile resolved'),
    );
  }
  for (const host of ['https://evl.pkg.github.com', 'https://npm.pkg.github.org'])
    expect(
      withEntry(key, {
        ...github('@agency/theme', '0.4.0-beta.1'),
        resolved: `${host}/download/@agency/theme/0.4.0-beta.1/${'a'.repeat(40)}`,
      }),
      host,
    ).toEqual(refused('lockfile resolved'));
});

it('refuses an alias entry and a link entry', () => {
  expect(withEntry('node_modules/astro', { ...registry('astro', '5.1.0'), name: 'astro' })).toEqual(
    refused('lockfile alias'),
  );
  expect(withEntry('node_modules/local', { resolved: '../local', link: true })).toEqual(
    refused('lockfile link'),
  );
});

it("refuses a key outside node_modules or a name outside npm's grammar", () => {
  for (const key of [
    'astro',
    'node_modules/',
    'node_modules/Astro',
    'node_modules/../astro',
    'node_modules/.bin',
    'node_modules/_astro',
    'node_modules/@scope',
    'node_modules/@/astro',
    'node_modules/astro/sub',
    'node_modules/astro//node_modules/vite',
    `node_modules/${'a'.repeat(215)}`,
    'node_modulez/astro',
    'vendor/libs/astro',
  ]) {
    expect(withEntry(key, registry('astro', '5.1.0')), key).toEqual(refused('lockfile name'));
  }
});

it('refuses an entry with no version, or a version that is not a plain string', () => {
  const entry = registry('astro', '5.1.0');
  for (const version of [undefined, 5, '', '5.1.0/../x']) {
    expect(withEntry('node_modules/astro', { ...entry, version }), String(version)).toEqual(
      refused('lockfile entry'),
    );
  }
});

it('reads a lockfile up to 16 MB, past the 1 MiB that holds other JSON, and refuses one byte more', () => {
  const root = PACKAGES[''] ?? {};
  const padded = (size: number) => {
    const bare = lock({ ...PACKAGES, '': { ...root, description: '' } }).length;
    return lock({ ...PACKAGES, '': { ...root, description: 'a'.repeat(size - bare) } });
  };
  expect(LOCKFILE_CAP).toBe(16_000_000);
  expect(checkLockfile(PACKAGE_JSON, padded(2_000_000), ['@agency'])).toEqual({ ok: true });
  expect(checkLockfile(PACKAGE_JSON, padded(LOCKFILE_CAP), ['@agency'])).toEqual({ ok: true });
  expect(checkLockfile(PACKAGE_JSON, padded(LOCKFILE_CAP + 1), ['@agency'])).toEqual(
    refused('too large'),
  );
  const manifest = JSON.stringify({ name: 'site', description: 'a'.repeat(1024 * 1024) });
  expect(checkLockfile(manifest, lock(), ['@agency'])).toEqual(refused('too large'));
});

it('reads both files as bytes, so bad UTF-8 or a byte-order mark is refused, not decoded', () => {
  const bad = Uint8Array.from([...new TextEncoder().encode(lock().slice(0, -1)), 0xff, 0x7d]);
  expect(checkLockfile(PACKAGE_JSON, bad, [])).toEqual(refused('not utf-8'));
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(PACKAGE_JSON)]);
  expect(checkLockfile(bom, lock(), [])).toMatchObject({ ok: false, reason: 'lockfile refused' });
});

it('refuses entry values of the wrong JSON type, never reading them as text', () => {
  const entry = registry('astro', '5.1.0');
  const at = (value: Record<string, unknown>) => withEntry('node_modules/astro', value);
  expect(at({ ...entry, version: ['5.1.0'] })).toEqual(refused('lockfile entry'));
  expect(at({ ...entry, integrity: [entry['integrity']] })).toEqual(refused('lockfile integrity'));
  for (const resolved of [undefined, 7, [entry['resolved']]])
    expect(at({ ...entry, resolved }), String(resolved)).toEqual(refused('lockfile resolved'));
  const scoped = github('@agency/theme', '0.4.0-beta.1');
  for (const resolved of [undefined, 7, [scoped['resolved']]])
    expect(
      withEntry('node_modules/@agency/theme', { ...scoped, resolved }),
      String(resolved),
    ).toEqual(refused('lockfile resolved'));
  for (const value of [null, 'astro', ['5.1.0']])
    expect(check({ ...PACKAGES, 'node_modules/astro': value })).toEqual(refused('lockfile entry'));
  for (const packages of [null, [entry], 'node_modules/astro'])
    expect(
      checkLockfile(PACKAGE_JSON, JSON.stringify({ lockfileVersion: 3, packages }), []),
      String(packages),
    ).toEqual(refused('lockfile entry'));
});
