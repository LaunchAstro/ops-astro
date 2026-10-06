// SPDX-License-Identifier: AGPL-3.0-only
//
// I1 (docs/plan/sandbox-contract.md, section 3) as a closed grammar: a
// `site.build` request is strict JSON with exactly `site`, `baseRevision`,
// `path` and `content`. The site must have a record and a pin with an image
// id (`unknown site`, `no pin`); `baseRevision` is 40 lowercase hex; the
// path is plain segments under one of the record's content directories,
// ending in one of its extensions; the content is a string of at most
// 64 KiB of UTF-8. Whether the path is a regular file at `baseRevision` is
// I2's to judge, from the tree.

import { expect, it } from 'vitest';
import { readBuildRequest } from '../../packages/core-sandbox/src/build-request.ts';
import type { SiteEntry } from '../../packages/core-sandbox/src/pin-list.ts';
import type { SiteRecord } from '../../packages/core-sandbox/src/site-record.ts';

const RECORD: SiteRecord = {
  buildCommand: ['npm', 'run', 'build'],
  outputDirectory: 'dist',
  nodeVersion: '22.12.0',
  buildEnv: [],
  scopes: [],
  contentDirectories: ['src/pages/', 'src/content/'],
  contentExtensions: ['.astro', '.md'],
  buildFormat: 'directory',
  trailingSlash: 'never',
  output: 'static',
};
const PINNED: SiteEntry = {
  lockfile: `sha256:${'a'.repeat(64)}`,
  image: `sha256:${'b'.repeat(64)}`,
  attempt: 1,
  commit: '',
  env: [],
};
const MAKING: SiteEntry = { ...PINNED, image: '', commit: 'e'.repeat(40), attempt: 2 };
const SITES = new Map([
  ['physio', { record: RECORD, entry: PINNED }],
  ['dental', { record: RECORD, entry: MAKING }],
]);
const siteOf = (id: string) => SITES.get(id) ?? null;
const REQUEST = {
  site: 'physio',
  baseRevision: 'c'.repeat(40),
  path: 'src/pages/about.astro',
  content: '<h1>About the clinic</h1>\n',
};
const read = (value: unknown) =>
  readBuildRequest(new TextEncoder().encode(JSON.stringify(value)), siteOf);
const withField = (key: string, value: unknown) => read({ ...REQUEST, [key]: value });
const refused = (why: string) => ({ ok: false, reason: 'input refused', why });

it('reads a request for one content file of a pinned site', () => {
  const result = read(REQUEST);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.request.site).toBe('physio');
  expect(result.request.path).toBe('src/pages/about.astro');
  expect(new TextDecoder().decode(result.request.content)).toBe(REQUEST.content);
  expect(result.record).toBe(RECORD);
  expect(result.entry).toBe(PINNED);
});

it('refuses a missing, extra or case-varied key and input that is not one object', () => {
  const { content: _content, ...missing } = REQUEST;
  expect(read(missing)).toEqual(refused('request key'));
  expect(read({ ...REQUEST, env: {} })).toEqual(refused('request key'));
  expect(read({ ...REQUEST, Path: 'src/pages/a.astro' })).toEqual(refused('request key'));
  expect(read([REQUEST])).toEqual(refused('request key'));
  const text = `{"site":"physio","site":"x","baseRevision":"${'c'.repeat(40)}","path":"src/pages/a.astro","content":""}`;
  expect(readBuildRequest(new TextEncoder().encode(text), siteOf)).toEqual(
    refused('duplicate key'),
  );
  expect(readBuildRequest(new TextEncoder().encode('{"site":'), siteOf)).toEqual(
    refused('json syntax'),
  );
});

it('refuses a site with no record as unknown and one whose pin is being made as no pin', () => {
  expect(withField('site', 'surgery')).toEqual({
    ok: false,
    reason: 'unknown site',
    why: 'site id',
  });
  expect(withField('site', 'dental')).toEqual({ ok: false, reason: 'no pin', why: 'pin image' });
  expect(withField('site', 7)).toEqual(refused('request value'));
  const looked: string[] = [];
  const spy = (id: string) => {
    looked.push(id);
    return siteOf(id);
  };
  for (const site of ['__proto__', 'Physio', 'a'.repeat(64), '-x', ''])
    expect(
      readBuildRequest(new TextEncoder().encode(JSON.stringify({ ...REQUEST, site })), spy),
    ).toEqual(refused('request value'));
  expect(looked).toEqual([]);
});

it('takes baseRevision only as 40 lowercase hex', () => {
  for (const revision of [
    'C'.repeat(40),
    'c'.repeat(39),
    'c'.repeat(41),
    'HEAD',
    `${'c'.repeat(39)}g`,
  ])
    expect(withField('baseRevision', revision)).toEqual(refused('request value'));
});

it("takes a path only under the record's directories with its extensions", () => {
  for (const path of ['src/content/blog/first-post.md', 'src/pages/blog/[slug].astro'])
    expect(withField('path', path).ok).toBe(true);
  for (const path of [
    'src/components/Card.astro',
    'src/pages/about.mdx',
    'src/pages/about.astro.ts',
    'src/pages/about',
    'src/pages/.astro',
    'src/pages/../../package.json',
    'src/pages/../pages/a.astro',
    'src/pages/./a.astro',
    'src/pages//a.astro',
    '/src/pages/a.astro',
    'src/pages\\a.astro',
    'src/pages/a b.astro',
    'SRC/pages/a.astro',
    'src/pagesx/a.astro',
    'astro.config.mjs',
    'package.json',
    7,
  ])
    expect(withField('path', path)).toEqual(refused('request path'));
});

it('holds the content to a string of at most 64 KiB of UTF-8', () => {
  expect(withField('content', 'a'.repeat(65_536)).ok).toBe(true);
  expect(withField('content', 'a'.repeat(65_537))).toEqual(refused('request content'));
  // 21,846 three-byte characters are 65,538 bytes, though fewer than 64 Ki units.
  expect(withField('content', '€'.repeat(21_846))).toEqual(refused('request content'));
  expect(withField('content', ['a'])).toEqual(refused('request content'));
  expect(withField('content', null)).toEqual(refused('request content'));
});
