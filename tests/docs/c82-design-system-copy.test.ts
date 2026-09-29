// SPDX-License-Identifier: AGPL-3.0-only
//
// C82: the design system's public edition. It crosses from the private
// design-system source as fresh files, after the real-names check reported
// zero hits over every one of them. Only text crosses (ruling (b), 29
// September 2026): screenshots, evidence and review records stay private, so
// nothing here may point at them. These cases hold the copy to its record, so
// a hand edit here, a file added beside it or a link out fails the build. The
// supporting checklist lines a test here can check each have one, named after
// the line; the real-names check itself, with its private list, is proven in
// the private repository before anything crosses, and its report is kept here.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';

const HOME = new URL('../../docs/design-system/', import.meta.url);
const RECORD = 'COPY-RECORD.md';
/** The real-names check's report, written into the copy by the check itself (C82). */
const NAMES = 'REAL-NAMES-REPORT.md';
const RETAKE = 'RETAKE-REPORT.md';
const PREFIX = 'docs/design-system/';

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

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const textOf = (name: string): string => read(name).toString('utf8');

/** The names report's rows: each file of the copy, the digest the check read, and its hits. */
const checked = (): Map<string, { digest: string; hits: number }> =>
  new Map(
    [
      ...textOf(NAMES).matchAll(
        /^\| `docs\/design-system\/([^`]+)` \| `([0-9a-f]{64})` \| (\d+) \|$/gmu,
      ),
    ].map((m) => [m[1]!, { digest: m[2]!, hits: Number(m[3]) }]),
  );

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: new URL('../..', import.meta.url), encoding: 'utf8' }).trim();

/** Why these bytes are not the ones the real-names check passed for the file, or undefined. */
function checkedDigestFault(name: string, bytes: Buffer): string | undefined {
  const row = checked().get(name);
  if (row === undefined) return `${name} was not checked`;
  if (row.hits !== 0) return `${name} had ${row.hits} hit(s)`;
  if (sha256(bytes) !== row.digest) return `${name} is not the file the check passed`;
  const recorded = name === RECORD ? undefined : rows().get(name);
  if (name !== RECORD && recorded !== sha256(bytes)) return `${name} differs from the copy record`;
  return undefined;
}

describe('C82 the design system crossed as a checked copy', () => {
  it('C82 copy record: every file is listed, and each matches its digest', () => {
    const listed = rows();
    expect(listed.size).toBe(11);
    expect(files().toSorted()).toEqual([...listed.keys(), RECORD, NAMES].toSorted());
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

  it('CS-16.21: C82 the design system crossed as fresh files with the scrub applied, every group retaken on synthetic data, and every file through the real-names check with zero hits', () => {
    const report = textOf(NAMES);
    const count = files().length;
    expect(report).toContain('- hits: 0\n');
    expect(report).toContain(`- files checked: ${count}\n`);
    expect(report).toContain(`- files copied: ${count}\n`);
    expect(report).toMatch(/^- names checked: [1-9]\d*$/mu);
    expect(report).toContain(`| \`${PREFIX}${NAMES}\` | this report`);
    expect([...checked().keys(), NAMES].toSorted()).toEqual(files().toSorted());
    for (const name of files().filter((one) => one !== NAMES)) {
      expect(checkedDigestFault(name, read(name)), name).toBeUndefined();
    }
    // The scrub came through the edition's build: each spec file carries its notice.
    for (const name of rows().keys()) {
      expect(textOf(name).startsWith('<!-- Public edition, generated'), name).toBe(true);
    }
    const retake = textOf(RETAKE);
    for (const group of ['SG-1', 'SG-2', 'SG-3', 'SG-4']) {
      const row = retake
        .split('\n')
        .find((line) => line.startsWith(`| ${group} | `) && !line.includes('| `'));
      expect(row, `${group}: no group row`).toMatch(/synthetic|reserved/u);
    }
    const folders = [
      ...retake.matchAll(/^\| [^|]+ \| `[^`]+` \| (\d+) \| [\d, ]+ \| ([a-z, ]+) \|$/gmu),
    ];
    expect(folders).toHaveLength(55);
    for (const [, shots, themes] of folders) {
      expect(Number(shots)).toBeGreaterThan(0);
      expect(themes).toBe('light, dark');
    }
  });

  it('Only fresh files cross: the product repository gains no commit whose parent comes from the private repository', () => {
    // The check compared every commit here with the private repository before the copy.
    expect(textOf(NAMES)).toMatch(
      /^- seed: PASS \(none of \d+ public commits is in the private repository\)$/mu,
    );
    // Fresh files: no link, and no repository inside the copy.
    for (const name of files()) {
      expect(lstatSync(new URL(name, HOME)).isSymbolicLink(), name).toBe(false);
      expect(name.split('/').includes('.git'), name).toBe(false);
    }
    // A private history merged in would bring its own root commit. A shallow clone (CI)
    // has no history to read, so there the seed line above is the proof.
    if (git('rev-parse', '--is-shallow-repository') === 'false') {
      expect(git('rev-list', '--max-parents=0', 'HEAD').split('\n')).toHaveLength(1);
    }
  });

  it('The synthetic replacements are applied before any capture, and headshots are replaced with synthetic ones', () => {
    const retake = textOf(RETAKE);
    expect(retake).toContain('The synthetic data was put in place before any capture');
    const staff = retake
      .split('\n')
      .find((line) => line.startsWith('| SG-1 | ') && !line.includes('| `'));
    expect(staff).toMatch(
      /headshot files replaced under the same names by drawn flat-colour avatars/u,
    );
    expect(retake).toMatch(
      /^- Headshots: no retaken file has the digest of an original headshot \(0 matches\)\.$/mu,
    );
    expect(retake).toMatch(/^- Real names: .*: 0 real hits after the retake\.$/mu);
    // No image crosses at all (the text-only ruling), so no face does either.
    const images = files().filter((name) => /\.(png|jpe?g|gif|webp|svg|avif)$/iu.test(name));
    expect(images).toEqual([]);
  });

  it('A planted name in any copied file after the check fails the copy against its checked digests', () => {
    for (const name of files().filter((one) => one !== NAMES)) {
      const planted = Buffer.concat([
        read(name),
        Buffer.from('\nA planted name: Made-up Person.\n'),
      ]);
      expect(checkedDigestFault(name, planted), name).toBe(
        `${name} is not the file the check passed`,
      );
    }
    // And a file the check never read fails too.
    expect(checkedDigestFault('PLANTED.md', Buffer.from('A planted name.'))).toBe(
      'PLANTED.md was not checked',
    );
  });
});
