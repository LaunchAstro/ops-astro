// SPDX-License-Identifier: AGPL-3.0-only
//
// Every refusal a verb line can give before it needs a credential is given
// before any credential file is opened, by the real process. The bearer and
// delegation files, plain and per preset, are FIFOs: opening one for reading
// blocks until a writer comes, so a run that reads one is killed at the
// timeout and fails here. A preload records and refuses every fetch.
//
// Missing and stale credentials need a read, so they are proved on ordinary
// files (`verb-preset-never-falls-back-or-retries`).

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const PRELOAD = pathToFileURL(join(import.meta.dirname, 'fetch-refusing-preload.mjs')).href;
const ELSEWHERE = 'https://elsewhere.example.test';
const TIMEOUT_MS = 15_000;

let folder: string;
let base: Record<string, string>;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'cli-refusal-fifo-'));
  for (const name of ['token', 'delegation']) {
    for (const tail of ['', '.sandbox', '.production']) {
      execFileSync('mkfifo', [join(folder, `${name}${tail}`)]);
    }
  }
  base = {
    PATH: process.env['PATH'] ?? '',
    OPS_ASTRO_TOKEN_FILE: join(folder, 'token'),
    OPS_ASTRO_DELEGATION_FILE: join(folder, 'delegation'),
    OPS_ASTRO_BUSINESS: 'alpha',
  };
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

interface Case {
  readonly name: string;
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly unset?: readonly string[];
  readonly exit: number;
}

const PRESET = ['--env', 'sandbox'];

const CASES: readonly Case[] = [
  {
    name: 'an unknown verb flag',
    argv: ['task', 'create', '--title', 'T', '--envv', 'production', '--agent'],
    exit: 2,
  },
  {
    name: 'an unknown verb flag under a preset',
    argv: ['task', 'create', '--title', 'T', '--envv', 'production', '--agent', ...PRESET],
    exit: 2,
  },
  { name: 'an unknown verb', argv: ['task', 'frobnicate', '--agent', ...PRESET], exit: 2 },
  { name: 'a verb value missing', argv: ['task', 'create', '--agent', ...PRESET], exit: 2 },
  {
    name: 'a verb value that is not whole',
    argv: ['task', 'update', 'T-1', '--revision', 'x', '--agent', ...PRESET],
    exit: 2,
  },
  ...['api', 'gotrue', 'web', 'env', 'business'].flatMap((flag) => [
    { name: `--${flag} with no value`, argv: ['task', 'list', '--agent', `--${flag}`], exit: 2 },
    { name: `--${flag}= empty`, argv: ['task', 'list', '--agent', `--${flag}=`], exit: 2 },
  ]),
  { name: 'an unknown preset flag', argv: ['task', 'list', '--agent', '--env', 'bogus'], exit: 2 },
  {
    name: 'an unknown preset variable',
    argv: ['task', 'list', '--agent'],
    env: { OPS_ASTRO_ENV: 'bogus' },
    exit: 2,
  },
  ...['api', 'gotrue', 'web'].map((flag) => ({
    name: `--${flag} beside a preset`,
    argv: ['task', 'list', '--agent', ...PRESET, `--${flag}`, ELSEWHERE],
    exit: 2,
  })),
  ...[
    'OPS_ASTRO_API_URL',
    'OPS_ASTRO_GOTRUE_URL',
    'OPS_ASTRO_WEB_URL',
    'SUPABASE_PUBLISHABLE_KEY',
    'OPS_ASTRO_TOKEN',
    'OPS_ASTRO_DELEGATION',
  ].map((variable) => ({
    name: `${variable} beside a preset`,
    argv: ['task', 'list', '--agent', ...PRESET],
    env: { [variable]: 'hand-set-value' },
    exit: 2,
  })),
  {
    name: 'no business under a preset',
    argv: ['task', 'list', '--agent', ...PRESET],
    unset: ['OPS_ASTRO_BUSINESS'],
    exit: 2,
  },
  {
    name: 'no business by hand',
    argv: ['task', 'list', '--agent'],
    unset: ['OPS_ASTRO_BUSINESS'],
    exit: 2,
  },
  { name: 'help', argv: ['help'], env: { OPS_ASTRO_ENV: 'bogus' }, exit: 0 },
];

describe('a refused verb line opens no credential file and sends nothing', () => {
  CASES.forEach((one, index) => {
    it(
      `${one.name}: exit ${String(one.exit)} before any read`,
      () => {
        const record = join(folder, `fetches-${String(index)}`);
        const env: Record<string, string> = { ...base, ...one.env, FETCH_RECORD: record };
        for (const name of one.unset ?? []) Reflect.deleteProperty(env, name);
        const ran = spawnSync(
          process.execPath,
          ['--import', PRELOAD, 'apps/cli/main.ts', ...one.argv],
          { cwd: ROOT, env, encoding: 'utf8', timeout: TIMEOUT_MS, input: '' },
        );
        expect(ran.signal, 'killed at the timeout: it opened a credential file').toBeNull();
        expect(ran.status, ran.stderr).toBe(one.exit);
        expect(existsSync(record) ? readFileSync(record, 'utf8') : '').toBe('');
      },
      TIMEOUT_MS + 5_000,
    );
  });
});
