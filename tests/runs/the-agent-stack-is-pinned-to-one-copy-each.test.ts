// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R4, the pinned stack: the root manifest names each package at its
// exact pin, the workspace overrides hold the family to one copy, and the
// real lockfile, read with a YAML parser (every document in it), resolves exactly one version of
// each, at the pin. No provider package is in it: no `openai`, no
// `@anthropic-ai/*`, and no `@langchain/*` beyond core, langgraph, its
// checkpoint, its SDK and its protocol. From 19 Oct 23:19Z the repository's
// release-age rule would let a second, newer langgraph in through
// `langchain`'s own range, so the overrides are load-bearing.
//
// Hostile: a lockfile with a second langgraph and a provider package planted
// is refused by the same check.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';

const PINS: Readonly<Record<string, string>> = {
  langchain: '1.5.16',
  '@langchain/core': '1.2.17',
  '@langchain/langgraph': '1.4.21',
  '@langchain/langgraph-checkpoint': '1.1.6',
  langsmith: '0.9.0',
  zod: '4.6.6',
};
const DIRECT = ['langchain', '@langchain/core', '@langchain/langgraph', 'langsmith', 'zod'];
const OVERRIDDEN = [
  '@langchain/langgraph',
  '@langchain/core',
  '@langchain/langgraph-checkpoint',
  'langsmith',
];
const ALLOWED_LANGCHAIN = new Set([
  '@langchain/core',
  '@langchain/langgraph',
  '@langchain/langgraph-checkpoint',
  '@langchain/langgraph-sdk',
  '@langchain/protocol',
]);

/** Each package the lockfile resolves, and its versions. */
function resolved(lockfile: string): Map<string, Set<string>> {
  // pnpm writes its environment's lock as a document before the project's.
  const documents = parseAllDocuments(lockfile).map(
    (document) => (document.toJS() ?? {}) as { packages?: Record<string, unknown> },
  );
  const packages = Object.assign(
    {},
    ...documents.map((document) => document.packages ?? {}),
  ) as Record<string, unknown>;
  const found = new Map<string, Set<string>>();
  for (const key of Object.keys(packages)) {
    const at = key.lastIndexOf('@');
    const [name, version] = at > 0 ? [key.slice(0, at), key.slice(at + 1)] : [key, ''];
    found.set(name, (found.get(name) ?? new Set()).add(version));
  }
  return found;
}

/** What is wrong with a lockfile's agent stack: a pin missed, a second copy, a provider. */
function stackFaults(lockfile: string): readonly string[] {
  const found = resolved(lockfile);
  const faults: string[] = [];
  for (const [name, pin] of Object.entries(PINS)) {
    const versions = [...(found.get(name) ?? [])];
    if (versions.length !== 1 || versions[0] !== pin) {
      faults.push(`${name}: ${versions.join(', ') || 'absent'}`);
    }
  }
  for (const name of found.keys()) {
    const provider = name === 'openai' || name.startsWith('@anthropic-ai/');
    if (provider || (name.startsWith('@langchain/') && !ALLOWED_LANGCHAIN.has(name))) {
      faults.push(`${name}: not allowed`);
    }
  }
  return faults;
}

const LOCKFILE = readFileSync('pnpm-lock.yaml', 'utf8');

describe('the agent stack is pinned to one copy each', () => {
  it('the root manifest pins each package exactly, and the overrides hold the family', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies: Record<string, string>;
    };
    for (const name of DIRECT) expect(manifest.dependencies[name], name).toBe(PINS[name]);
    const workspace = parse(readFileSync('pnpm-workspace.yaml', 'utf8')) as {
      overrides: Record<string, string>;
      minimumReleaseAgeExclude: readonly string[];
    };
    for (const name of OVERRIDDEN) expect(workspace.overrides[name], name).toBe(PINS[name]);
    const exempt = workspace.minimumReleaseAgeExclude.filter((entry) =>
      /^(@langchain\/|langchain@|langsmith@|zod@)/u.test(entry),
    );
    expect(exempt, 'no release-age exemption for the stack').toEqual([]);
  });

  it('the lockfile resolves one copy of each, at its pin, and no provider package', () => {
    expect(stackFaults(LOCKFILE)).toEqual([]);
  });

  it('a second langgraph, a provider package or a missing pin is refused', () => {
    const planted = LOCKFILE.replace(
      /^packages:\n/mu,
      [
        'packages:',
        "  '@langchain/langgraph@1.5.0':",
        '    resolution: {integrity: sha512-x}',
        "  '@langchain/openai@1.6.2':",
        '    resolution: {integrity: sha512-x}',
        '  openai@7.32.0:',
        '    resolution: {integrity: sha512-x}',
        '',
      ].join('\n'),
    );
    expect(stackFaults(planted).toSorted()).toEqual(
      [
        '@langchain/langgraph: 1.5.0, 1.4.21',
        '@langchain/openai: not allowed',
        'openai: not allowed',
      ].toSorted(),
    );
    expect(stackFaults('lockfileVersion: "9.0"\n')).toHaveLength(Object.keys(PINS).length);
  });
});
