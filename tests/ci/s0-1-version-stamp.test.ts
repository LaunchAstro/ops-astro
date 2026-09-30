// SPDX-License-Identifier: AGPL-3.0-only
//
// `S0-1 version stamp` (ticket S0-1, supporting line C2): every build carries
// its version, the build identifier, written by the build into its own
// artefact, and the page template shows it in a fixed place. The template half
// is `tests/surfaces/s0-1-version-stamp.test.tsx`; this file is the build half.
//
// The web build here is the real one: the application's own Vite
// configuration, built into a scratch directory, so `apps/web/dist` is left to
// `pnpm build` and the artefact read below is the one that configuration
// writes, not a copy of its rules.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import { buildIdentifier, readStamp, STAMP_FILE, STAMP_META } from '../../apps/web/build-stamp.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 's0-1-version-stamp-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

describe('S0-1 version stamp', () => {
  versionStampCases1();
  versionStampCases2();
});

function versionStampCases1() {
  it('names the commit, and says so when the tree differs from it', () => {
    const repo = join(scratch, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(
      repo,
      '-c',
      'user.name=Stamp',
      '-c',
      'user.email=stamp@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'one',
    );
    const head = git(repo, 'rev-parse', 'HEAD').trim();

    expect(buildIdentifier(repo)).toBe(head.slice(0, 12));
    writeFileSync(join(repo, 'a.txt'), 'b\n');
    expect(buildIdentifier(repo)).toBe(`${head.slice(0, 12)}-dirty`);
  });

  it('refuses a directory that is not a checkout rather than inventing an identifier', () => {
    const plain = join(scratch, 'not-a-checkout');
    mkdirSync(plain);
    expect(() => buildIdentifier(plain)).toThrow(/build identifier/u);
  });

  it('reads a stamp only when the artefact holds a well-formed one', () => {
    const artefact = join(scratch, 'artefact');
    mkdirSync(artefact);
    expect(readStamp(artefact)).toBeUndefined();
    writeFileSync(join(artefact, STAMP_FILE), 'not json\n');
    expect(readStamp(artefact)).toBeUndefined();
    writeFileSync(join(artefact, STAMP_FILE), '{"build":"latest"}\n');
    expect(readStamp(artefact)).toBeUndefined();
    writeFileSync(join(artefact, STAMP_FILE), '{"build":"0123456789ab-dirty"}\n');
    expect(readStamp(artefact)).toBe('0123456789ab-dirty');
  });
}

function versionStampCases2() {
  it('the web build writes its identifier into its artefact, its page and its bundle', async () => {
    const outDir = join(scratch, 'dist');
    await build({
      configFile: join(root, 'apps', 'web', 'vite.config.ts'),
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    });
    const expected = buildIdentifier(root);

    // The artefact: the file a promotion step reads the version from.
    expect(readStamp(outDir)).toBe(expected);
    // The entry document: what the served line compares the page against.
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    expect(html).toMatch(new RegExp(`<meta name="${STAMP_META}" content="${expected}"`, 'u'));
    // The bundle: the value the shell draws, compiled in rather than fetched.
    const assets = join(outDir, 'assets');
    const code = readdirSync(assets)
      .filter((file) => file.endsWith('.js'))
      .map((file) => readFileSync(join(assets, file), 'utf8'))
      .join('\n');
    expect(code).toContain(JSON.stringify(expected));
  }, 60_000);
}
