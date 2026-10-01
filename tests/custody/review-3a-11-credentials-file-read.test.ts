// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-BATCH-2 #312, batch 3a, n=11: aw-01-custody.test.ts's "the broker's
// process never holds the key" and "no key is reachable from a configuration
// file loaded outside custody" check process.env and grep for
// CUSTODY_CREDENTIALS_FILE only. A broker that read MODEL_BROKER_CREDENTIALS_FILE
// (or TRACE_EXPORT_CREDENTIALS_FILE) itself would pass both. This scan reads
// every tracked source file under packages/ and apps/ and finds each fs read
// whose argument is a *_CREDENTIALS_FILE setting, directly or through a name
// assigned from one; the only such read is custody-main.ts's.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const CUSTODY_MAIN = 'packages/core-custody/src/custody-main.ts';

const sources = (): readonly string[] =>
  execFileSync('git', ['ls-files', '--', 'packages', 'apps'], { cwd: ROOT, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((file) => /\.(?:[cm]?[jt]sx?)$/u.test(file));

const SETTING = /\b[A-Z][A-Z0-9_]*_CREDENTIALS_FILE\b/gu;
const READ = /\b(?:readFileSync|readFile|createReadStream|openSync|open|opendir)\s*\(/gu;

/** The text between the call's parentheses, balanced, from the '(' at `start`. */
function argumentsAt(source: string, start: number): string {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(start + 1, index);
    }
  }
  return source.slice(start + 1);
}

/** Each fs read in a source whose argument carries a credential-file setting, as `line: call`. */
function credentialReads(source: string): readonly string[] {
  // Names that hold a setting: a binding or property assigned from an expression naming one.
  const tainted = new Set<string>(['credentialsFile']);
  for (const match of source.matchAll(
    /(?:\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=|\b([A-Za-z_$][\w$]*)\s*:)\s*([^;\n]*)/gu,
  )) {
    const name = match[1] ?? match[2] ?? '';
    const value = match[3] ?? '';
    if (/_CREDENTIALS_FILE\b/u.test(value) || /\bcredentialsFile\b/u.test(value)) {
      tainted.add(name);
    }
  }
  const found: string[] = [];
  for (const match of source.matchAll(READ)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const args = argumentsAt(source, open);
    const carries =
      /_CREDENTIALS_FILE\b/u.test(args) ||
      [...tainted].some((name) =>
        new RegExp(`(?<![\\w$])${name.replaceAll('$', '\\$')}(?![\\w$])`, 'u').test(args),
      );
    if (carries) {
      const line = source.slice(0, match.index).split('\n').length;
      found.push(`${String(line)}: ${match[0]}${args})`);
    }
  }
  return found;
}

it('REVIEW-3A-11: the scan is not vacuous: it knows both broker settings and finds custody-main.ts its own read', () => {
  const settings = new Set(
    sources().flatMap((file) =>
      [...readFileSync(resolve(ROOT, file), 'utf8').matchAll(SETTING)].map((m) => m[0]),
    ),
  );
  expect(settings).toContain('MODEL_BROKER_CREDENTIALS_FILE');
  expect(settings).toContain('TRACE_EXPORT_CREDENTIALS_FILE');
  expect(credentialReads(readFileSync(resolve(ROOT, CUSTODY_MAIN), 'utf8')).length).toBeGreaterThan(
    0,
  );
  expect(
    credentialReads(`const f = value('MODEL_BROKER_CREDENTIALS_FILE');\nreadFileSync(f, 'utf8');`),
  ).toHaveLength(1);
  expect(credentialReads(`readFileSync(value('TRACE_EXPORT_CREDENTIALS_FILE'))`)).toHaveLength(1);
  expect(credentialReads(`readFileSync(settings.credentialsFile)`)).toHaveLength(1);
});

it('REVIEW-3A-11: no fs read outside custody-main.ts takes a *_CREDENTIALS_FILE setting (the broker never reads its own key file)', () => {
  const offenders = sources()
    .filter((file) => file !== CUSTODY_MAIN)
    .flatMap((file) =>
      credentialReads(readFileSync(resolve(ROOT, file), 'utf8')).map((read) => `${file}:${read}`),
    );
  expect(offenders).toEqual([]);
});
