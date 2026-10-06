// SPDX-License-Identifier: AGPL-3.0-only
//
// The pin list (docs/plan/sandbox-contract.md, terms and B8) as a closed
// grammar: strict JSON with exactly `probe`, `base` and `sites`. The probe
// entry is one image id; `base` holds one entry per known platform with its
// image id and the one S2 `Env` list; each site entry, keyed by a site id,
// holds its lockfile digest, its S1 image id (empty exactly while a pin is
// being made, when the site commit F2 builds is named), its attempt number
// and its S1 `Env` list. An `Env` list is `NAME=value` items with unique
// names. Anything else leaves the file unread.

import { expect, it } from 'vitest';
import { readPinList } from '../../packages/core-sandbox/src/pin-list.ts';

const faulted = (why: string) => ({ ok: false, reason: 'internal', why });
const ID = (fill: string) => `sha256:${fill.repeat(64)}`;
const COMMON = [
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  'HOME=/tmp/home',
  'HOSTNAME=sandbox',
];
const S1_OPEN = [...COMMON, 'NODE_ENV=production', 'ASTRO_TELEMETRY_DISABLED=1'];
const S2_OPEN = [
  ...COMMON,
  'ASTRO_TELEMETRY_DISABLED=1',
  'npm_config_offline=true',
  'npm_config_ignore_scripts=true',
  'npm_config_cache=/tmp/npm-cache',
];
const ENV = [...S1_OPEN, 'NODE_VERSION=22.12.0', 'PUBLIC_SITE_NAME=Clinic'];
const BASE_ENV = [...S2_OPEN, 'NODE_VERSION=22.12.0'];
const SITE = { lockfile: ID('a'), image: ID('b'), attempt: 1, commit: '', env: ENV };
const LIST = {
  probe: { image: ID('c') },
  base: { 'linux/arm64': { image: ID('d'), env: BASE_ENV } },
  sites: { 'townsville-physio': SITE },
};
const read = (value: unknown) => readPinList(new TextEncoder().encode(JSON.stringify(value)));
const withSite = (patch: Record<string, unknown>) =>
  read({ ...LIST, sites: { 'townsville-physio': { ...SITE, ...patch } } });

it('reads the probe, a base per platform and a site entry', () => {
  const result = read(LIST);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.pins.probe).toBe(ID('c'));
  expect(result.pins.base.get('linux/arm64')).toEqual({ image: ID('d'), env: BASE_ENV });
  expect(result.pins.sites.get('townsville-physio')).toEqual(SITE);
  expect(result.pins.sites.get('another-site')).toBeUndefined();
});

it('reads a site entry while its pin is being made: no image id, the commit F2 builds', () => {
  expect(withSite({ image: '', commit: 'e'.repeat(40), attempt: 2 }).ok).toBe(true);
  expect(withSite({ image: '', commit: '' })).toEqual(faulted('pin list'));
  expect(withSite({ image: ID('b'), commit: 'e'.repeat(40) })).toEqual(faulted('pin list'));
});

it('refuses a missing, extra or misspelt key at every level', () => {
  const { sites: _sites, ...noSites } = LIST;
  expect(read(noSites)).toEqual(faulted('pin list'));
  expect(read({ ...LIST, extra: {} })).toEqual(faulted('pin list'));
  expect(read({ ...LIST, probe: { image: ID('c'), env: BASE_ENV } })).toEqual(faulted('pin list'));
  expect(read({ ...LIST, base: { 'linux/arm64': { image: ID('d') } } })).toEqual(
    faulted('pin list'),
  );
  const { attempt: _attempt, ...noAttempt } = SITE;
  expect(read({ ...LIST, sites: { 'townsville-physio': noAttempt } })).toEqual(faulted('pin list'));
  expect(withSite({ Image: ID('b') })).toEqual(faulted('pin list'));
});

it('takes image ids and lockfile digests only as sha256 of 64 lowercase hex', () => {
  for (const id of [
    ID('B'),
    `sha256:${'a'.repeat(63)}`,
    'a'.repeat(64),
    `sha512:${'a'.repeat(64)}`,
  ])
    expect(read({ ...LIST, probe: { image: id } })).toEqual(faulted('pin list'));
  expect(withSite({ lockfile: '' })).toEqual(faulted('pin list'));
  expect(withSite({ lockfile: ID('A') })).toEqual(faulted('pin list'));
});

it('takes a known platform, a site id grammar and an attempt number from 1', () => {
  expect(read({ ...LIST, base: { 'linux/amd64': LIST.base['linux/arm64'] } }).ok).toBe(true);
  expect(read({ ...LIST, base: {} })).toEqual(faulted('pin list'));
  expect(read({ ...LIST, base: { 'linux/riscv64': LIST.base['linux/arm64'] } })).toEqual(
    faulted('pin list'),
  );
  for (const id of ['Townsville', '-site', 'site-', 'a'.repeat(64), 'a_b', '../x'])
    expect(read({ ...LIST, sites: { [id]: SITE } })).toEqual(faulted('pin list'));
  for (const attempt of [0, -1, 1.5, '1', 2 ** 31])
    expect(withSite({ attempt })).toEqual(faulted('pin list'));
});

it('takes an Env list of NAME=value items with unique names after the fixed opening', () => {
  for (const tail of [
    ['PATH'],
    ['=x'],
    ['1A=x'],
    ['A-B=x'],
    ['A=x', 'A=y'],
    ['A=x\ny'],
    ['A=caf\u00E9'],
    [7],
  ])
    expect(withSite({ env: [...S1_OPEN, ...tail] })).toEqual(faulted('pin list'));
  expect(withSite({ env: 'A=x' })).toEqual(faulted('pin list'));
  expect(withSite({ env: [...S1_OPEN, 'A=', 'B=x=y'] }).ok).toBe(true);
});

it("holds each Env list to B3: the class's fixed pairs first, in order, then no npm configuration", () => {
  for (const env of [
    [],
    ['NODE_VERSION=22.12.0'],
    S1_OPEN.slice(1),
    [S1_OPEN[1], S1_OPEN[0], ...S1_OPEN.slice(2)],
    [...S1_OPEN.slice(0, 4), 'ASTRO_TELEMETRY_DISABLED=0'],
    S2_OPEN,
    [...S1_OPEN, 'HOME=/root'],
    [...S1_OPEN, 'NPM_CONFIG_IGNORE_SCRIPTS=false'],
    [...S1_OPEN, 'npm_config_registry=https://example.invalid'],
    [...S1_OPEN, 'public_site_name=x'],
  ])
    expect(withSite({ env })).toEqual(faulted('pin list'));
  for (const env of [
    S1_OPEN,
    [...S2_OPEN, 'npm_config_OFFLINE=false'],
    [...S2_OPEN, 'HOME=/root'],
  ]) {
    const base = { 'linux/arm64': { image: ID('d'), env } };
    expect(read({ ...LIST, base })).toEqual(faulted('pin list'));
  }
});

it('refuses a base entry with an extra key or a bad image id, and values of the wrong JSON type', () => {
  const base = (entry: unknown) => read({ ...LIST, base: { 'linux/arm64': entry } });
  expect(base({ image: ID('d'), env: BASE_ENV, extra: 1 })).toEqual(faulted('pin list'));
  expect(base({ image: 'sha256:x', env: BASE_ENV })).toEqual(faulted('pin list'));
  expect(base([ID('d'), BASE_ENV])).toEqual(faulted('pin list'));
  expect(withSite({ image: '', commit: ['e'.repeat(40)] })).toEqual(faulted('pin list'));
  expect(read({ ...LIST, sites: [SITE] })).toEqual(faulted('pin list'));
  expect(read({ ...LIST, base: [LIST.base['linux/arm64']] })).toEqual(faulted('pin list'));
  const twice = `{"probe":{"image":"${ID('c')}"},"probe":{"image":"${ID('c')}"},"base":{},"sites":{}}`;
  expect(readPinList(new TextEncoder().encode(twice))).toEqual(faulted('duplicate key'));
});
