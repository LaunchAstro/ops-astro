// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12, part one: the candidates, pinned and with their licences read, as
// recorded data. Nothing is fetched or installed: the licences go through the
// product's own licence check, and no candidate is anywhere in the product's
// dependency tree (`AW-12 candidate audit`, as far as part one reaches; the
// audit at each pinned commit runs in the candidate's throwaway environment).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CANDIDATES, licenceReport, pinFaults, type CandidateRecord } from './candidates.ts';

const H = (entry: string): CandidateRecord => {
  const found = CANDIDATES.find((candidate) => candidate.entry === entry);
  if (found === undefined) throw new Error(`no entry ${entry}`);
  return found;
};

/** The product's licence check on `report`: its exit status and what it printed. */
function licenceCheck(report: unknown): { readonly status: number; readonly output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aw12-licences-'));
  try {
    const file = join(dir, 'report.json');
    writeFileSync(file, JSON.stringify(report));
    try {
      const output = execFileSync('node', ['scripts/licences/check.mjs', '--report', file], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, output };
    } catch (failed) {
      const { status, stderr } = failed as { status: number; stderr: string };
      return { status, output: stderr };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const escaped = (name: string): string => name.replaceAll(/[.*+?^${}()|[\]\\/]/gu, '\\$&');

/** The candidate packages named in `text` as a lockfile or manifest names a dependency. */
function candidatesIn(text: string, names: readonly string[]): string[] {
  return names.filter((name) =>
    new RegExp(`(^|[\\s'"])${escaped(name)}(@\\d|['"]?\\s*:)`, 'mu').test(text),
  );
}

const ALL_PACKAGES = CANDIDATES.flatMap((candidate) => candidate.packages);

describe('AW-12 candidates', () => {
  it('the candidates entered are the ones the decision names, the checkpointer entered separately', () => {
    expect(CANDIDATES.map((c) => [c.entry, c.packages.join('+'), c.version])).toEqual([
      ['H1', 'deepagents', '1.13.4'],
      ['H2', '@langchain/langgraph', '1.4.14'],
      ['H2b', '@langchain/langgraph-checkpoint-postgres', '1.0.5'],
      ['H3', 'langflow+lfx', '1.12.1'],
      ['H1/H2 dep', 'langchain+@langchain/core', '1.5.11'],
    ]);
    expect(H('H3').tag).toBe('v1.12.1');
    expect(H('H1').requires).toEqual(['H2', 'H1/H2 dep']);
  });

  it('each is pinned to its release tag and the commit it resolves to, its licence read at that commit', () => {
    for (const candidate of CANDIDATES) {
      expect(pinFaults(candidate), candidate.entry).toEqual([]);
      expect(candidate.licences[0]?.url).toContain(`/blob/${candidate.commit}/LICENSE`);
    }
  });
});

describe('AW-12 candidates, pinning and licences', () => {
  it('a range, latest, a short commit or a licence read off the pin is not a pin', () => {
    const base = H('H2');
    const cases: [Partial<CandidateRecord>, string][] = [
      [{ version: '^1.4.14', tag: '@langchain/langgraph@^1.4.14' }, 'version'],
      [{ version: 'latest', tag: '@langchain/langgraph@latest' }, 'version'],
      [{ tag: '@langchain/langgraph@1.4.15' }, 'tag'],
      [{ commit: '9ae75600' }, 'commit'],
      [{ commit: 'main' }, 'commit'],
      [{ licences: [] }, 'licence missing'],
      [
        {
          licences: [{ path: 'LICENSE', spdx: 'MIT', url: `${base.repository}/blob/main/LICENSE` }],
        },
        'licence not read at the pin',
      ],
      [{ licences: [{ ...base.licences[0], spdx: ' ' } as never] }, 'licence not read at the pin'],
      [{ repository: 'http://github.com/langchain-ai/langgraphjs' }, 'repository'],
    ];
    for (const [change, fault] of cases) {
      expect(pinFaults({ ...base, ...change }), JSON.stringify(change)).toContain(fault);
    }
  });

  it('the recorded licences pass the product licence check, and an incompatible one is refused', () => {
    const passed = licenceCheck(licenceReport(CANDIDATES));
    expect(passed.status, passed.output).toBe(0);
    const sspl = { ...H('H3'), licences: [{ ...H('H3').licences[0], spdx: 'SSPL-1.0' } as never] };
    const refused = licenceCheck(licenceReport([...CANDIDATES.slice(0, 3), sspl]));
    expect(refused.status).toBe(1);
    expect(refused.output).toMatch(/langflow/u);
  });

  it('what the licence reading did not establish is carried, never dropped', () => {
    for (const candidate of CANDIDATES) {
      expect(candidate.unread.join(' '), candidate.entry).toMatch(/transitive dependency tree/u);
    }
    expect(H('H3').unread.join(' ')).toMatch(/Apache-2\.0 at the older reviewed revision/u);
    expect(H('H3').runtime).toBe('python');
  });
});

const manifests = (): string[] => [
  'package.json',
  ...['apps', 'packages'].flatMap((root) =>
    readdirSync(root)
      .map((dir) => join(root, dir, 'package.json'))
      .filter((file) => existsSync(file)),
  ),
];

describe('AW-12 candidate audit', () => {
  it('no candidate is in the product lockfile or any workspace package manifest', () => {
    const lockfile = readFileSync('pnpm-lock.yaml', 'utf8');
    // Control: the scan reads the lockfile's own entries.
    expect(candidatesIn(lockfile, ['vitest', '@types/node'])).toEqual(['vitest', '@types/node']);
    expect(candidatesIn(lockfile, ALL_PACKAGES)).toEqual([]);
    expect(manifests().length).toBeGreaterThan(1);
    for (const file of manifests()) {
      expect(candidatesIn(readFileSync(file, 'utf8'), ALL_PACKAGES), file).toEqual([]);
    }
  });

  it('the scan finds a candidate however the lockfile or a manifest names it', () => {
    const planted = [
      "  '@langchain/langgraph@1.4.14':",
      '      deepagents:',
      '    "langchain": "1.5.11",',
      "      '@langchain/core':\t",
      '  lfx@0.1.0:',
    ].join('\n');
    expect(candidatesIn(planted, ALL_PACKAGES).toSorted()).toEqual(
      ['@langchain/core', '@langchain/langgraph', 'deepagents', 'langchain', 'lfx'].toSorted(),
    );
    // A name inside another is not that name.
    expect(candidatesIn("  '@langchain/langgraph-sdk@1.0.0':", ['@langchain/langgraph'])).toEqual(
      [],
    );
  });
});
