// SPDX-License-Identifier: AGPL-3.0-only
//
// C82: the design system's public edition. It crosses from the private
// design-system source as fresh files, after the real-names check reported
// zero hits over every one of them. Only text crosses (ruling (b), 29
// September 2026): screenshots, evidence and review records stay private, so
// nothing here may point at them. These cases hold the copy to its record, so
// a hand edit here, a file added beside it or a link out fails the build.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';

const HOME = new URL('../../docs/design-system/', import.meta.url);
const RECORD = 'COPY-RECORD.md';

function files(folder = ''): string[] {
  return readdirSync(new URL(folder || '.', HOME), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(`${folder}${entry.name}/`) : [`${folder}${entry.name}`],
  );
}

const read = (name: string): Buffer => readFileSync(new URL(name, HOME));
const rows = (): Map<string, string> =>
  new Map(
    [
      ...read(RECORD)
        .toString('utf8')
        .matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gmu),
    ].map((m) => [m[1]!, m[2]!]),
  );

describe('C82 the design system crossed as a checked copy', () => {
  it('C82 copy record: every file is listed, and each matches its digest', () => {
    const listed = rows();
    expect(listed.size).toBe(10);
    expect(files().toSorted()).toEqual([...listed.keys(), RECORD].toSorted());
    for (const [name, digest] of listed) {
      expect(createHash('sha256').update(read(name)).digest('hex'), name).toBe(digest);
    }
  });

  it('C82 no screenshot and no link to anything that did not cross', () => {
    const present = new Set(files());
    for (const name of present) {
      const text = read(name).toString('utf8');
      // Report the file and the target only, never the surrounding text.
      expect(/<img\b/iu.test(text), `${name}: an HTML image`).toBe(false);
      expect(text.includes('!['), `${name}: an image, inline or by reference`).toBe(false);
      expect(
        text.includes('ops-astro-roadmap'),
        `${name}: a pointer to the private repository`,
      ).toBe(false);
      const targets = [
        ...[...text.matchAll(/\[(?:[^[\]\n]|\[[^[\]\n]*\])*\]\(<?([^()\s<>]*)/gu)].map((m) => m[1]),
        ...[...text.matchAll(/^ {0,3}\[[^[\]\n]+\]:[ \t]*<?([^\s<>]+)/gmu)].map((m) => m[1]),
        ...[...text.matchAll(/<a\s[^>]*?href\s*=\s*(["'])(.*?)\1/giu)].map((m) => m[2]),
      ];
      for (const target of targets) {
        const path = target!.split('#')[0]!;
        if (!path) continue;
        expect(path.includes('://'), `${name}: ${target} leaves the copy`).toBe(false);
        const resolved = posix.normalize(posix.join(posix.dirname(name), path));
        expect(present.has(resolved), `${name}: ${target} did not cross`).toBe(true);
      }
    }
  });
});
