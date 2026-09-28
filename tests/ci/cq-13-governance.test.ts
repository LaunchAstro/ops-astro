// SPDX-License-Identifier: AGPL-3.0-only
// CQ-13: the governance documents say one thing, and the merge gate keeps
// every check it had. Product issues 43 and 50, and the issue list, were
// answered on the roadmap's ticket; these cases hold the repository to them.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
// Prettier and hand wrapping move line breaks; the sentence is what must agree.
const flat = (text: string): string => text.replace(/\s+/gu, ' ');

// Product issue 43: the roadmap's rule (D36-5, build safeguards rule 3).
const MERGE_RULE =
  "The merge rule: an agent merges on Nathan's credential once every required check is green on the head being merged; a change touching one of the eight protected components merges only on that component's green conformance proof and Nathan's acceptance; the production deploy is the one other human gate.";
const MERGE_DOCS = [
  'CONTRIBUTING.md',
  'AGENTS.md',
  'AI_POLICY.md',
  'docs/agents/model-roles.md',
  'docs/adr/0001-pocock-loop-is-the-build-method.md',
  'docs/adr/0046-merge-mode-machine-proven-merges.md',
  'docs/plan/ruleset.md',
  'docs/supply-chain-pins.md',
  'docs/current-decisions.md',
];
// The rules these documents stated before, in the words they used.
const OTHER_RULES = [/human-merged/iu, /\bhuman merge\b/iu, /\bNathan merges\b/u];

it('CQ-13 merge rule agrees', () => {
  for (const path of MERGE_DOCS) {
    const text = flat(read(path));
    expect(text, path).toContain(MERGE_RULE);
    for (const other of OTHER_RULES) expect(text, `${path} states another rule`).not.toMatch(other);
  }
});

it('CQ-13 commit rule stated', () => {
  const text = flat(read('CONTRIBUTING.md'));
  expect(text).toContain('Keep every pull request under 250 commits');
  expect(text).toContain("A pull request that cannot be split waits for Nathan's line");
  expect(text).toContain('the removal and the restore are recorded on its ticket');
});

it('CQ-13 issues pointer list', () => {
  const rows = read('docs/ISSUES.md')
    .split('\n')
    .filter((line) => /^\| \[#\d+\]/u.test(line));
  expect(rows.length).toBeGreaterThanOrEqual(31);
  for (const row of rows) {
    // The first cell links the closed issue; every other cell is checked.
    const cells = row.split('|').slice(2, -1).join('|');
    expect(cells, row).toMatch(/\| roadmap (?:[A-Z][A-Z0-9]*-?[0-9A-Z-]*\d)/u);
    expect(cells, `${row} carries a path`).not.toMatch(
      /[\w.-]+\/[\w.-]+|\.(?:md|ts|mjs|sh|json|ya?ml)\b/u,
    );
    expect(cells, `${row} carries a name`).not.toMatch(/\b(?:Nathan|Mulligan)\b/u);
  }
});

// The required checks on the primary ruleset before CQ-13, as read from the
// live ruleset on 28 September 2026. Those this repository's workflow emits
// must still be emitted; the two app checks keep their configuration.
const REQUIRED_FROM_CI = [
  'contamination gate',
  'gitleaks over the full history',
  'local checks',
  'database conformance gate',
  'database conformance',
  'OSI licence allowlist',
  'commit messages and provenance',
  'review evidence for this revision',
  'pull request size',
];

it('CQ-13 no check dropped', () => {
  const ci = read('.github/workflows/ci.yml');
  const jobs = [...ci.matchAll(/^ {4}name: (.+)$/gmu)].map((m) => m[1]?.trim());
  for (const name of REQUIRED_FROM_CI) expect(jobs, name).toContain(name);
  expect(ci).toContain('run: node scripts/review-evidence-check.mjs');
  expect(ci).toContain('run: bash tests/ci/review-evidence-cases.sh');
  expect(read('.github/dco.yml')).toContain('require:');
  expect(flat(read('docs/plan/ruleset.md'))).toContain(
    'review-evidence, pull-request-size and DCO results',
  );
});
