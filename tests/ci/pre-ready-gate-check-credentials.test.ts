// SPDX-License-Identifier: AGPL-3.0-only
// Audit proof for the pre-ready gate's whole check (scripts/pre-ready-steps.mjs):
// the caller's checker variables and tokens must not reach `pnpm check`.
// The values below are stand-ins, never a real token.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, extname, join } from 'node:path';
import { expect, it } from 'vitest';
// @ts-expect-error -- the gate is a plain JavaScript module, as lanes run it
import * as gate from '../../scripts/pre-ready-steps.mjs';

const { wholeCheck } = gate;
const STAND_INS = { GH_TOKEN: 'stand-in-gh-marker', GITHUB_TOKEN: 'stand-in-github-marker' };

/** Puts a `pnpm` launcher for `pnpm` first on PATH. */
function pnpmOnPath(dir: string, pnpm: string, path: string | undefined): void {
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const target = ['.js', '.cjs', '.mjs'].includes(extname(pnpm))
    ? `"${process.execPath}" "${pnpm}"`
    : `"${pnpm}"`;
  writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\nexec ${target} "$@"\n`, { mode: 0o755 });
  process.env['PATH'] = `${bin}${delimiter}${path ?? ''}`;
}

/** A package whose `check` records which tokens it saw and fails on GH_TOKEN. */
function checkPackage(pkg: string): void {
  mkdirSync(pkg);
  writeFileSync(
    join(pkg, 'check.cjs'),
    [
      "const names = ['GH_TOKEN', 'GITHUB_TOKEN'].filter((n) => process.env[n] !== undefined);",
      "require('node:fs').writeFileSync('seen.json', JSON.stringify(names));",
      'process.exit(process.env.GH_TOKEN === undefined ? 0 : 1);',
    ].join('\n'),
  );
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: 'gate-env-case',
      private: true,
      scripts: { check: 'node check.cjs' },
    }),
  );
}

it('the whole check launches pnpm check without the caller’s tokens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pre-ready-env-'));
  const saved = {
    npm_execpath: process.env['npm_execpath'],
    PATH: process.env['PATH'],
    GH_TOKEN: process.env['GH_TOKEN'],
    GITHUB_TOKEN: process.env['GITHUB_TOKEN'],
  };
  try {
    // An available pnpm on PATH: the one running this run, so npm_execpath can be unset.
    const pnpm = saved.npm_execpath;
    if (pnpm !== undefined) pnpmOnPath(dir, pnpm, saved.PATH);
    delete process.env['npm_execpath'];
    Object.assign(process.env, STAND_INS);

    const pkg = join(dir, 'pkg');
    checkPackage(pkg);

    const result = wholeCheck({ cwd: pkg, skip: false });
    const seen: unknown = JSON.parse(readFileSync(join(pkg, 'seen.json'), 'utf8'));
    expect({ seen, ok: result.ok, message: result.message }).toEqual({
      seen: [],
      ok: true,
      message: 'pnpm check passed.',
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
