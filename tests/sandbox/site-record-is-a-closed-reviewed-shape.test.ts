// SPDX-License-Identifier: AGPL-3.0-only
//
// I6 (docs/plan/sandbox-contract.md, section 3) as a closed grammar: a site
// record is strict JSON with exactly its ten keys. The build command is the
// one allowed argv (`npm run build`), the output directory `dist`, the Node
// version a plain x.y.z, the build variables `PUBLIC_` names (public by
// Astro's own rule, since the build prints them into pages) or a name B3
// fixes, whose value B3 then gives; the private scopes npm scopes; the
// content allow-list a subset of I1's three directories and three
// extensions; and `build.format`, `trailingSlash` and `output` from Astro's
// own values, `output` static only. Anything else is refused.

import { expect, it } from 'vitest';
import { readSiteRecord } from '../../packages/core-sandbox/src/site-record.ts';

const faulted = (why: string) => ({ ok: false, reason: 'internal', why });
const RECORD = {
  buildCommand: ['npm', 'run', 'build'],
  outputDirectory: 'dist',
  nodeVersion: '22.12.0',
  buildEnv: { PUBLIC_SITE_NAME: 'Townsville Physio', PUBLIC_PHONE: '07 4700 0000' },
  scopes: ['@agencyastro'],
  contentDirectories: ['src/pages/', 'src/content/'],
  contentExtensions: ['.astro', '.md'],
  buildFormat: 'directory',
  trailingSlash: 'never',
  output: 'static',
};
const read = (value: unknown) => readSiteRecord(new TextEncoder().encode(JSON.stringify(value)));
const withField = (key: string, value: unknown) => read({ ...RECORD, [key]: value });
const many = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, n) => [`PUBLIC_V${String(n)}`, 'x']));

it('reads a record with its ten keys', () => {
  const result = read(RECORD);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.record.buildEnv).toEqual([
    ['PUBLIC_SITE_NAME', 'Townsville Physio'],
    ['PUBLIC_PHONE', '07 4700 0000'],
  ]);
  expect(result.record.scopes).toEqual(['@agencyastro']);
  expect(result.record.contentDirectories).toEqual(['src/pages/', 'src/content/']);
  expect(result.record.contentExtensions).toEqual(['.astro', '.md']);
});

it('refuses a missing key, an extra key and input that is not one JSON object', () => {
  const { output: _dropped, ...missing } = RECORD;
  expect(read(missing)).toEqual(faulted('site record'));
  expect(read({ ...RECORD, deployHook: 'x' })).toEqual(faulted('site record'));
  expect(read([RECORD])).toEqual(faulted('site record'));
  expect(readSiteRecord(new TextEncoder().encode('{"output":"static","output":"server"}'))).toEqual(
    faulted('duplicate key'),
  );
});

it('takes only the one allowed build command', () => {
  for (const command of [
    ['npm', 'run', 'build', '--', '--x'],
    ['npm', 'run', 'build '],
    ['sh', '-c', 'npm run build'],
    'npm run build',
    ['npx', 'astro', 'build'],
  ])
    expect(withField('buildCommand', command)).toEqual(faulted('site record'));
});

it('takes dist as the output directory and a plain Node version', () => {
  expect(withField('outputDirectory', 'build')).toEqual(faulted('site record'));
  expect(withField('outputDirectory', './dist')).toEqual(faulted('site record'));
  for (const version of ['22', '22.12', 'v22.12.0', '22.12.0-rc.1', '22.12.0 ', 22])
    expect(withField('nodeVersion', version)).toEqual(faulted('site record'));
});

it('takes a build variable a page may print and refuses any other name', () => {
  expect(withField('buildEnv', { HOME: '/root', PUBLIC_X: 'y' }).ok).toBe(true);
  for (const name of [
    'API_KEY',
    'SECRET',
    'GITHUB_TOKEN',
    'public_x',
    'PUBLIC_',
    'PUBLIC_x',
    'PUBLIC-X',
    'NODE_OPTIONS',
    'npm_config_registry',
  ])
    expect(withField('buildEnv', { [name]: 'v' })).toEqual(faulted('record env'));
});

it('takes a build value of printable ASCII up to 1,024 characters and 32 variables', () => {
  expect(withField('buildEnv', { PUBLIC_X: 'a'.repeat(1024) }).ok).toBe(true);
  expect(withField('buildEnv', { PUBLIC_X: 'a'.repeat(1025) })).toEqual(faulted('record env'));
  for (const value of ['a\nb', 'a\u0000b', 'café', 7, null])
    expect(withField('buildEnv', { PUBLIC_X: value })).toEqual(faulted('record env'));
  expect(withField('buildEnv', many(32)).ok).toBe(true);
  expect(withField('buildEnv', many(33))).toEqual(faulted('record env'));
});

it('takes npm scopes and refuses a repeated or malformed one', () => {
  expect(withField('scopes', []).ok).toBe(true);
  for (const scopes of [['agencyastro'], ['@Agency'], ['@a/b'], ['@a', '@a'], ['@']])
    expect(withField('scopes', scopes)).toEqual(faulted('site record'));
});

it('takes a content allow-list inside I1 and refuses anything wider', () => {
  for (const directories of [
    [],
    ['src/'],
    ['src/pages'],
    ['src/pages/', 'src/pages/'],
    ['public/'],
  ])
    expect(withField('contentDirectories', directories)).toEqual(faulted('site record'));
  for (const extensions of [[], ['.ts'], ['astro'], ['.md', '.md'], ['.json']])
    expect(withField('contentExtensions', extensions)).toEqual(faulted('site record'));
});

it("holds build.format, trailingSlash and output to Astro's values, output static", () => {
  for (const format of ['directory', 'file', 'preserve'])
    expect(withField('buildFormat', format).ok).toBe(true);
  for (const slash of ['always', 'never', 'ignore'])
    expect(withField('trailingSlash', slash).ok).toBe(true);
  expect(withField('buildFormat', 'Directory')).toEqual(faulted('site record'));
  expect(withField('trailingSlash', true)).toEqual(faulted('site record'));
  expect(withField('output', 'server')).toEqual(faulted('site record'));
});

it('refuses lists and the variable map given as another JSON type', () => {
  for (const scopes of ['@agencyastro', { '@agencyastro': true }, null])
    expect(withField('scopes', scopes)).toEqual(faulted('site record'));
  expect(withField('contentDirectories', 'src/pages/')).toEqual(faulted('site record'));
  for (const env of [null, ['PUBLIC_X=y'], 'PUBLIC_X=y'])
    expect(withField('buildEnv', env)).toEqual(faulted('record env'));
});
