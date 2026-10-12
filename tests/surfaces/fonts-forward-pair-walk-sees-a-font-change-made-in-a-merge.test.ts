// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function -- the reviewer's proof, kept as written */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { stripTypeScriptTypes } from 'node:module';
import { expect, it } from 'vitest';

it('the fonts forward-pair walk sees a font change made in the merge of a side branch', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sol1476-font-merge-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  const cssPath = 'packages/ui/src/styles/0-fonts.css';
  const pinPath = 'packages/ui/package.json';
  const testPath = 'tests/surfaces/mp-1-2-fonts-icons-brand.test.tsx';
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  };
  const commit = (message: string) => {
    git('add', '.');
    git('-c', 'user.name=Sol proof', '-c', 'user.email=sol@example.test', 'commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q', '-b', 'main');
    const face = "@font-face {\nfont-family: 'Funnel Sans';\nfont-weight: 100 900;\n}";
    write(cssPath, face);
    write(
      pinPath,
      JSON.stringify({ dependencies: { '@fontsource-variable/funnel-sans': '1.0.0' } }),
    );
    write(testPath, 'funnel-sans-latin-wght-normal.woff2 expect(face).toContain');
    const beforeAnchor = commit('before the anchor');
    write('main-marker', 'main');
    const anchor = commit('anchor');
    git('checkout', '-qb', 'side', beforeAnchor);
    write('side-marker', 'side');
    commit('side branch forked before the anchor');
    git('checkout', '-q', 'main');
    git(
      '-c',
      'user.name=Sol proof',
      '-c',
      'user.email=sol@example.test',
      'merge',
      '--no-commit',
      '--no-ff',
      'side',
    );
    write(cssPath, face.replace('100 900', '200 800'));
    const head = commit('merge changes the font without a forward pair');
    expect(git('show', `${head}^:${cssPath}`)).not.toBe(git('show', `${head}:${cssPath}`));
    const source = readFileSync(
      'tests/surfaces/fonts-forward-pair-and-production-woff2.test.ts',
      'utf8',
    );
    const start = source.indexOf('  const shown =');
    const end = source.indexOf('  const unpaired:');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const walk = new Function(
      'git',
      'cssPath',
      'pinPath',
      'testPath',
      'anchor',
      'head',
      'variableFace',
      'facePackage',
      'fontFile',
      'normalise',
      stripTypeScriptTypes(
        'function walk() {\n' + source.slice(start, end) + '\nreturn changes; }',
      ) + '\nreturn walk();',
    );
    const changes = walk(
      git,
      cssPath,
      pinPath,
      testPath,
      anchor,
      head,
      /@font-face\s*\{\s*font-family:\s*'Funnel Sans';[\s\S]*?\n\}/u,
      '@fontsource-variable/funnel-sans',
      'funnel-sans-latin-wght-normal.woff2',
      (css: string) => css.trim(),
    );
    expect(changes).toContain(head);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
