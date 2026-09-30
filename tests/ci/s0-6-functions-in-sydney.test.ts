// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-6 functions in Sydney (ticket S0-6, the Vercel re-plan's new line): every
// function in the build output runs in Sydney (`syd1`), none on the edge
// runtime and no middleware, which would run outside Australia; and nothing is
// prerendered, which Vercel's edge network would keep. The deploy refuses a
// build output that says otherwise. Asked of `buildOutputProblems` over real
// directories in Vercel's Build Output API (version 3) layout, one good and
// then each way of saying otherwise, the hostile spellings included.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildOutputProblems } from '../../scripts/ops/build-output.ts';

const scratch = mkdtempSync(join(tmpdir(), 's0-6-syd-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Files = Record<string, string | object>;

const SYDNEY_NODE = { runtime: 'nodejs22.x', handler: 'index.mjs', regions: ['syd1'] };

/** A build output that holds: one Node function in Sydney, static pages, no middleware. */
const GOOD: Files = {
  'config.json': { version: 3, routes: [{ handle: 'filesystem' }] },
  'static/index.html': '<!doctype html>',
  'functions/api/index.func/.vc-config.json': SYDNEY_NODE,
  'functions/api/index.func/index.mjs': 'export {};',
};

let outputs = 0;

function output(files: Files): string {
  outputs += 1;
  const root = join(scratch, `output-${String(outputs)}`);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

const withFunction = (config: unknown, path = 'functions/api/index.func'): Files => ({
  ...GOOD,
  [`${path}/.vc-config.json`]: typeof config === 'string' ? config : (config as object),
  [`${path}/index.mjs`]: 'export {};',
});

describe('S0-6 functions in Sydney', () => {
  holdsCase();
  regionCases();
  runtimeCases();
  middlewareCases();
  prerenderCase();
  shapeCases();
});

function holdsCase() {
  it('a Node function in syd1, static pages and no middleware hold', () => {
    expect(buildOutputProblems(output(GOOD))).toStrictEqual([]);
  });
}

function regionCases() {
  it('refuses a function anywhere but syd1, however it is spelt', () => {
    for (const regions of [
      undefined,
      [],
      ['SYD1'],
      [' syd1'],
      ['syd1', 'iad1'],
      ['all'],
      'syd1',
      ['syd1', 'syd1'],
    ]) {
      const config = { ...SYDNEY_NODE, regions };
      const problems = buildOutputProblems(output(withFunction(config)));
      expect(problems, JSON.stringify(regions)).not.toStrictEqual([]);
    }
    // A second function, nested deeper, is read too.
    const nested = {
      ...GOOD,
      ...withFunction({ ...SYDNEY_NODE, regions: ['iad1'] }, 'functions/api/deep/er.func'),
    };
    expect(buildOutputProblems(output(nested))).not.toStrictEqual([]);
  });
}

function runtimeCases() {
  it('refuses the edge runtime and anything that is not a Node function', () => {
    for (const config of [
      { runtime: 'edge', entrypoint: 'index.js', regions: ['syd1'] },
      { ...SYDNEY_NODE, runtime: 'Edge' },
      { ...SYDNEY_NODE, runtime: 'python3.12' },
      { ...SYDNEY_NODE, entrypoint: 'index.js' },
      { handler: 'index.mjs', regions: ['syd1'] },
      '{ "runtime": "nodejs22.x", "regions": ["syd1"], ',
      '[]',
    ]) {
      const problems = buildOutputProblems(output(withFunction(config)));
      expect(problems, JSON.stringify(config)).not.toStrictEqual([]);
    }
    // A function with no config at all.
    const bare = { ...GOOD, 'functions/api/other.func/index.mjs': 'export {};' };
    expect(buildOutputProblems(output(bare))).not.toStrictEqual([]);
  });
}

function middlewareCases() {
  it('refuses middleware, however the routes name it', () => {
    for (const route of [
      { src: '/(.*)', middlewarePath: '_middleware' },
      { src: '/(.*)', middlewareRawSrc: ['/'] },
      { src: '/(.*)', middleware: 0 },
    ]) {
      const files = { ...GOOD, 'config.json': { version: 3, routes: [route] } };
      expect(buildOutputProblems(output(files)), JSON.stringify(route)).not.toStrictEqual([]);
    }
  });
}

function prerenderCase() {
  it('refuses anything prerendered, which the edge network would keep', () => {
    const files = {
      ...GOOD,
      'functions/api/index.prerender-config.json': { expiration: 60 },
    };
    expect(buildOutputProblems(output(files))).not.toStrictEqual([]);
  });
}

function shapeCases() {
  it('refuses a symlink under functions, and an output with no function or config', () => {
    const linked = output(GOOD);
    // A directory of functions elsewhere, one of them outside Sydney, linked in.
    const elsewhere = output(withFunction({ ...SYDNEY_NODE, regions: ['iad1'] }));
    symlinkSync(join(elsewhere, 'functions'), join(linked, 'functions/more'));
    expect(buildOutputProblems(linked)).not.toStrictEqual([]);

    const onlyStatic = { 'config.json': GOOD['config.json'] as object, 'static/a.html': '' };
    expect(buildOutputProblems(output(onlyStatic))).not.toStrictEqual([]);
    const { 'config.json': _v, ...noVersion } = GOOD;
    expect(buildOutputProblems(output(noVersion))).not.toStrictEqual([]);
    const wrongVersion = { ...GOOD, 'config.json': { version: 2 } };
    expect(buildOutputProblems(output(wrongVersion))).not.toStrictEqual([]);
    expect(buildOutputProblems(join(scratch, 'nowhere'))).not.toStrictEqual([]);
  });
}
