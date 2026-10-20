// SPDX-License-Identifier: AGPL-3.0-only
//
// #1693, criterion 3: the hosted API holds no site custody. Only the site
// runner on the M5 starts custody with the site destinations. The API starts
// custody for its own mail, model and trace destinations, so `startCustody`
// alone is not the line: it never names `siteCustody`, `siteDestination` or
// the runner's `custodySites`, and never imports the site runner or
// `site-custody.ts`, so no site destination is ever one of its own. Every file under apps/api is
// parsed with swc (the parser .dependency-cruiser.cjs uses), never a line
// pattern, and every identifier and string in its syntax tree is read, so an
// aliased import, a member read or a bracketed name is seen.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from '@swc/core';
import { describe, expect, it } from 'vitest';

const NAMES = new Set(['siteCustody', 'siteDestination', 'custodySites']);
const PATHS = [/apps\/site-runner\//u, /core-custody\/src\/site-custody/u];

/** Every identifier and string literal in a source's syntax tree. */
function words(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) words(child, out);
  } else if (typeof node === 'object' && node !== null) {
    const record = node as Record<string, unknown>;
    if (
      (record['type'] === 'Identifier' || record['type'] === 'StringLiteral') &&
      typeof record['value'] === 'string'
    ) {
      out.push(record['value']);
    }
    for (const value of Object.values(record)) words(value, out);
  }
  return out;
}

/** What a source names of site custody: forbidden names and paths, each once. */
function reaches(source: string, tsx: boolean): readonly string[] {
  const tree = parseSync(source, { syntax: 'typescript', tsx });
  const seen = words(tree).filter(
    (word) => NAMES.has(word) || PATHS.some((path) => path.test(word)),
  );
  return [...new Set(seen)].toSorted();
}

function sources(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path);
    return /\.(?:[cm]?ts|tsx)$/u.test(entry.name) ? [path] : [];
  });
}

describe('the API reaches no site custody', () => {
  it('names no site custody in any file under apps/api', () => {
    const found = sources('apps/api').flatMap((file) =>
      reaches(readFileSync(file, 'utf8'), file.endsWith('.tsx')).map((word) => `${file}: ${word}`),
    );
    expect(found).toStrictEqual([]);
  });

  it.each([
    [
      "import { siteCustody as carry } from '../../packages/core-custody/src/index.ts';",
      'siteCustody',
    ],
    [
      "import * as custody from '../../packages/core-custody/src/index.ts';\ncustody.siteCustody;",
      'siteCustody',
    ],
    [
      "import * as custody from '../../packages/core-custody/src/index.ts';\ncustody['siteDestination'];",
      'siteDestination',
    ],
    [
      "const runner = await import('../site-runner/sites.ts'.replace('', '../../apps/site-runner/sites.ts'));",
      '../../apps/site-runner/sites.ts',
    ],
    [
      "import { x } from '../../packages/core-custody/src/site-custody.ts';",
      '../../packages/core-custody/src/site-custody.ts',
    ],
  ])('sees a planted reach: %s', (source, word) => {
    expect(reaches(source, false)).toContain(word);
  });
});
