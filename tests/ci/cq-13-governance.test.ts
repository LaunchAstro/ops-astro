// SPDX-License-Identifier: AGPL-3.0-only
// CQ-13: the governance documents say one thing, and the merge gate keeps
// every check it had.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
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
const OTHER_RULES = [
  /human-merged/iu,
  /\bhuman merge\b/iu,
  /\bNathan merges\b/u,
  // Sol's first CQ-13 review: green checks alone stated as the whole rule.
  /\brule is every required check green\b/iu,
  /\bno discretion beyond that rule\b/iu,
];

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

// The required status checks on the primary ruleset (23396133) before CQ-13,
// read from the live ruleset on 28 September 2026 as context and app id.
// `.github/required-checks.json` is the list after the change; it must hold
// every one of these, bound to the same app. Sol's first CQ-13 review: the test compares
// the two lists, not job names or prose.
const ACTIONS = 15368;
const BEFORE = [
  ['local checks', ACTIONS],
  ['contamination gate', ACTIONS],
  ['gitleaks over the full history', ACTIONS],
  ['OSI licence allowlist', ACTIONS],
  ['commit messages and provenance', ACTIONS],
  ['pull request size', ACTIONS],
  ['review evidence for this revision', ACTIONS],
  ['CodeQL', 57789],
  ['DCO', 1861],
  ['database conformance gate', ACTIONS],
  ['database conformance', ACTIONS],
] as const;

type Check = { context: string; integration_id: number };

it('CQ-13 no check dropped', () => {
  const after = (
    JSON.parse(read('.github/required-checks.json')) as { required_status_checks: Check[] }
  ).required_status_checks.map((c) => `${c.context} @ ${c.integration_id}`);
  for (const [context, app] of BEFORE) expect(after).toContain(`${context} @ ${app}`);
  // Every Actions check the list requires is a job this repository's CI emits.
  const ci = read('.github/workflows/ci.yml');
  const jobs = [...ci.matchAll(/^ {4}name: (.+)$/gmu)].map((m) => m[1]?.trim());
  for (const entry of after.filter((c) => c.endsWith(` @ ${ACTIONS}`)))
    expect(jobs, entry).toContain(entry.slice(0, -` @ ${ACTIONS}`.length));
});
