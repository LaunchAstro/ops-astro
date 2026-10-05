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
const ENV = ['PATH=/usr/bin:/bin', 'HOME=/tmp/home', 'npm_config_offline=true'];
const SITE = { lockfile: ID('a'), image: ID('b'), attempt: 1, commit: '', env: ENV };
const LIST = {
  probe: { image: ID('c') },
  base: { 'linux/arm64': { image: ID('d'), env: ENV } },
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
  expect(result.pins.base.get('linux/arm64')).toEqual({ image: ID('d'), env: ENV });
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
  expect(read({ ...LIST, probe: { image: ID('c'), env: ENV } })).toEqual(faulted('pin list'));
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

it('takes an Env list of NAME=value items with unique names', () => {
  for (const env of [
    ['PATH'],
    ['=x'],
    ['1A=x'],
    ['A-B=x'],
    ['A=x', 'A=y'],
    ['A=x\ny'],
    ['A=café'],
    'A=x',
    [7],
  ])
    expect(withSite({ env })).toEqual(faulted('pin list'));
  expect(withSite({ env: ['A=', 'B=x=y'] }).ok).toBe(true);
});
