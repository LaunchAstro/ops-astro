// SPDX-License-Identifier: AGPL-3.0-only
//
// B3 (docs/plan/sandbox-contract.md, section 4): the environment is exact
// per class. S1 is PATH, HOME, HOSTNAME, NODE_ENV and
// ASTRO_TELEMETRY_DISABLED at fixed values, then the base image's own
// variables, then the site record's build variables; S2 is the same fixed
// list without NODE_ENV, the npm configuration the launcher writes (offline,
// ignore-scripts, cache path), the base image's own variables and no site
// variable. A name already listed keeps its first value: a record or base
// image naming HOME gets B3's value (section 13, I4, B3 and B8).

import { expect, it } from 'vitest';
import { s1Env, s2Env } from '../../packages/core-sandbox/src/run-env.ts';
import type { SiteRecord } from '../../packages/core-sandbox/src/site-record.ts';

const PATH = 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const BASE = ['PATH=/opt/evil/bin', 'NODE_VERSION=22.12.0', 'YARN_VERSION=1.22.22'];
const record = (buildEnv: readonly (readonly [string, string])[]): SiteRecord => ({
  buildCommand: ['npm', 'run', 'build'],
  outputDirectory: 'dist',
  nodeVersion: '22.12.0',
  buildEnv,
  scopes: [],
  contentDirectories: ['src/pages/'],
  contentExtensions: ['.astro'],
  buildFormat: 'directory',
  trailingSlash: 'never',
  output: 'static',
});

it("gives S1 the fixed list, the base image's variables, then the record's", () => {
  expect(s1Env(BASE, record([['PUBLIC_SITE_NAME', 'Clinic']]))).toEqual([
    PATH,
    'HOME=/tmp/home',
    'HOSTNAME=sandbox',
    'NODE_ENV=production',
    'ASTRO_TELEMETRY_DISABLED=1',
    'NODE_VERSION=22.12.0',
    'YARN_VERSION=1.22.22',
    'PUBLIC_SITE_NAME=Clinic',
  ]);
});

it("gives a record naming HOME, NODE_ENV or a fixed name B3's value", () => {
  const env = s1Env(
    ['HOME=/root', 'HOSTNAME=x'],
    record([
      ['HOME', '/root'],
      ['NODE_ENV', 'development'],
      ['ASTRO_TELEMETRY_DISABLED', '0'],
      ['PATH', '/tmp'],
    ]),
  );
  expect(env).toEqual([
    PATH,
    'HOME=/tmp/home',
    'HOSTNAME=sandbox',
    'NODE_ENV=production',
    'ASTRO_TELEMETRY_DISABLED=1',
  ]);
});

it('gives S2 the fixed list and npm configuration, the base, and no site variable', () => {
  expect(s2Env([...BASE, 'npm_config_offline=false', 'HOME=/root'])).toEqual([
    PATH,
    'HOME=/tmp/home',
    'HOSTNAME=sandbox',
    'ASTRO_TELEMETRY_DISABLED=1',
    'npm_config_offline=true',
    'npm_config_ignore_scripts=true',
    'npm_config_cache=/tmp/npm-cache',
    'NODE_VERSION=22.12.0',
    'YARN_VERSION=1.22.22',
  ]);
});

it('lists each name once, compared whole', () => {
  const env = s1Env(['HOMEDIR=/x', 'HOME_X=y'], record([['PUBLIC_A', '1']]));
  expect(env).toContain('HOMEDIR=/x');
  expect(env).toContain('HOME_X=y');
  const names = env.map((item) => item.slice(0, item.indexOf('=')));
  expect(new Set(names).size).toBe(names.length);
});
