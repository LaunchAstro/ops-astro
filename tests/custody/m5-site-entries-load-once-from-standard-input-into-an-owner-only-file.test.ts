// SPDX-License-Identifier: AGPL-3.0-only
//
// The agency site's two credentials go into custody's credential file on the
// M5 by `scripts/m5/site-custody.ts load` (#1691, ADR 0028), run as the
// operator runs it: the value arrives on standard input from the password
// manager, never as an argument or a setting. Each entry is loaded once,
// read back, and the file is owner-only. A planted canary value is found in
// the credential file and nowhere else: not the output, the arguments, the
// environment or a file left beside it.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadSiteEntry } from '../../scripts/m5/site-custody.ts';

// A write that does not take, for the read-back's proof; the spawned runs use the real one.
const writes = vi.hoisted(() => ({ dropped: false }));
vi.mock('../../apps/cli/secret-file.ts', async (original) => {
  const real = await original<typeof import('../../apps/cli/secret-file.ts')>();
  return {
    publishSecret: (file: string, value: string) => {
      if (!writes.dropped) real.publishSecret(file, value);
    },
  };
});

const SCRIPT = join(import.meta.dirname, '../../scripts/m5/site-custody.ts');
const canary = () => `canary-${randomBytes(18).toString('hex')}`;

let folder: string;
let file: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'm5-site-load-'));
  file = join(folder, 'credentials.json');
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

const ENV = { PATH: process.env['PATH'] ?? '' };

function load(entry: string, value: string, extra: readonly string[] = []) {
  const args = [SCRIPT, 'load', '--entry', entry, '--file', file, ...extra];
  const run = spawnSync(process.execPath, args, {
    input: `${value}\n`,
    env: ENV,
    encoding: 'utf8',
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}`, args };
}

const entries = () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[];
const mode = () => statSync(file).mode & 0o777;

it('loads both entries into an owner-only file, read back, with each value only in that file', () => {
  const source = canary();
  const hosting = canary();
  const first = load('source_control', source);
  const second = load('hosting', hosting);
  expect([first.status, second.status]).toEqual([0, 0]);
  expect(mode()).toBe(0o600);
  expect(entries()).toEqual([
    {
      ref: 'source_control',
      kind: 'api_key',
      account: 'agency-astro-astro',
      destination: 'source_control',
      header: 'authorization',
      scheme: 'bearer',
      value: source,
    },
    {
      ref: 'hosting',
      kind: 'api_key',
      account: 'agency-astro-web',
      destination: 'hosting',
      header: 'authorization',
      scheme: 'bearer',
      value: hosting,
    },
  ]);
  for (const run of [first, second]) {
    expect(run.output).toMatch(/loaded and read back/u);
    for (const value of [source, hosting]) {
      expect(run.output.includes(value)).toBe(false);
      expect(run.args.join(' ').includes(value)).toBe(false);
      expect(Object.values(ENV).join(' ').includes(value)).toBe(false);
    }
  }
  // No temporary copy or lock left beside it.
  expect(readdirSync(folder)).toEqual(['credentials.json']);
});

it('loads an entry once: the same value again changes nothing, a different one is refused', () => {
  const value = canary();
  expect(load('source_control', value).status).toBe(0);
  const before = readFileSync(file, 'utf8');
  const again = load('source_control', value);
  expect(again).toMatchObject({ status: 0 });
  expect(again.output).toMatch(/already loaded/u);
  const other = canary();
  const replaced = load('source_control', other);
  expect(replaced.status).toBe(1);
  expect(replaced.output).toMatch(/ENTRY_ALREADY_LOADED/u);
  expect(replaced.output.includes(other) || replaced.output.includes(value)).toBe(false);
  expect(readFileSync(file, 'utf8')).toBe(before);
});

it.each([
  ['a value as an argument', 'source_control', ['--value', 'x']],
  ['an entry custody holds no destination for', 'openrouter', []],
  ['a second file named', 'hosting', ['--file', '/tmp/elsewhere.json']],
])('refuses %s and writes nothing', (_, entry, extra) => {
  const value = canary();
  const run = load(entry, value, extra);
  expect(run.status).toBe(1);
  expect(run.output.includes(value)).toBe(false);
  expect(readdirSync(folder)).toEqual([]);
});

it.each([
  ['an empty value', ''],
  ['a value with a space in it', 'abc defghijk'],
  ['a chat product session token', 'sk-ant-sid01-abcdefghijklmnop'],
])('refuses %s by its code and never echoes it', (_, value) => {
  const run = load('hosting', value);
  expect(run.status).toBe(1);
  expect(run.output).toMatch(/refused [A-Z_]+/u);
  if (value !== '') expect(run.output.includes(value)).toBe(false);
  expect(readdirSync(folder)).toEqual([]);
});

it('refuses a file others can read, a link at its place, and a load already running', () => {
  writeFileSync(file, '[]', { mode: 0o644 });
  chmodSync(file, 0o644);
  expect(load('hosting', canary()).output).toMatch(/LOAD_FILE_NOT_OWNER_ONLY/u);
  expect(readFileSync(file, 'utf8')).toBe('[]');
  rmSync(file);

  const target = join(folder, 'target.json');
  writeFileSync(target, '[]', { mode: 0o600 });
  symlinkSync(target, file);
  expect(load('hosting', canary()).output).toMatch(/LOAD_FILE_NOT_OWNER_ONLY/u);
  expect(readFileSync(target, 'utf8')).toBe('[]');
  rmSync(file);
  rmSync(target);

  writeFileSync(`${file}.lock`, '');
  const held = load('hosting', canary());
  expect(held).toMatchObject({ status: 1 });
  expect(held.output).toMatch(/LOAD_IN_PROGRESS/u);
  expect(readdirSync(folder)).toEqual(['credentials.json.lock']);
});

it('two loads at once, as separate processes, never lose an entry either reported loaded', async () => {
  const values = { source_control: canary(), hosting: canary() };
  const run = (entry: keyof typeof values) =>
    new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [SCRIPT, 'load', '--entry', entry, '--file', file], {
        env: ENV,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      child.on('exit', resolve);
      child.stdin.end(`${values[entry]}\n`);
    });
  const [source, hosting] = await Promise.all([run('source_control'), run('hosting')]);
  expect([source, hosting]).toContain(0);
  const held = entries().map((entry) => entry['ref']);
  if (source === 0) expect(held).toContain('source_control');
  if (hosting === 0) expect(held).toContain('hosting');
  expect(mode()).toBe(0o600);
});

it('says refused, never loaded, when the entry is not there to read back', () => {
  writes.dropped = true;
  try {
    expect(loadSiteEntry(file, 'hosting', canary())).toBe('refused LOAD_NOT_READ_BACK');
  } finally {
    writes.dropped = false;
  }
  expect(readdirSync(folder)).toEqual([]);
});
