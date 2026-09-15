// SPDX-License-Identifier: AGPL-3.0-only
// Review evidence, bound to the revision being merged.
//
// ADR 0046: Nathan merges only what the machine has already proven, and the
// required checks include a code-review evidence check and a security-review
// check. Round four found neither in continuous integration, so a pull
// request could carry a review of one revision and merge another, or carry no
// review at all, and the merge button would still open.
//
// Two rules.
//
// 1. The pull request body carries the review checkpoint block from
//    scripts/review-preflight.mjs, and its head is the head being merged.
//    Evidence for a different revision is not evidence for this one; that is
//    the whole point of recording the head.
// 2. If the change touches the sensitive surface ADR 0046 names, the body
//    also carries a security review bound to the same head.
//
// It reads PR_BODY, HEAD_SHA and CHANGED_FILES so the same code runs in
// continuous integration and in its own tests.

import { execFileSync } from 'node:child_process';

const body = process.env['PR_BODY'] ?? '';
const head = (process.env['HEAD_SHA'] ?? '').trim();

if (head === '') {
  console.error('review-evidence: HEAD_SHA must be set.');
  process.exit(2);
}

// The surface ADR 0046 names, expressed as the paths that hold it. A keyword
// list would be guesswork; a path list is checkable and it is wrong in an
// obvious way when it is wrong, which is the better failure.
const SENSITIVE = [
  /^packages\/core-custody\//u, // custody
  /^packages\/core-connectors\//u, // tool execution and egress
  /^packages\/core-runtime\//u, // the agent loop, gates, the audit chain
  /^apps\/worker\//u, // tool execution
  /^scripts\/gate\//u, // the contamination gate itself
  /^\.husky\//u, // the hooks that enforce it
  /^\.github\/workflows\//u, // what runs with repository credentials
  /(^|\/)(auth|tenancy|egress|custody|audit)[^/]*\.(ts|tsx|mjs|js|py|sql)$/u,
];

const changed =
  process.env['CHANGED_FILES'] !== undefined
    ? process.env['CHANGED_FILES']
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean)
    : (() => {
        const base = process.env['BASE_SHA'];
        if (base === undefined || base === '') return [];
        const mergeBase = execFileSync('git', ['merge-base', base, head], {
          encoding: 'utf8',
        }).trim();
        return execFileSync('git', ['diff', '--name-only', `${mergeBase}...${head}`], {
          encoding: 'utf8',
        })
          .split('\n')
          .map((f) => f.trim())
          .filter(Boolean);
      })();

const sensitive = changed.filter((f) => SENSITIVE.some((r) => r.test(f)));

// Did the review happen, and what did it conclude?
//
// Round five found this check matching the words "security review" and a
// hash, so a body saying the review was NOT RUN, with the current hash beside
// it, passed. Matching text is not establishing that a review happened. A
// reviewer states an outcome, and there are only three kinds.
//
// Refusals and absences come first: a line that says both "not run" and "no
// findings" is a contradiction, and the safe reading of a contradiction is
// the one that does not authorise a merge.
const ABSENT =
  /\b(?:not\s+run|not\s+performed|not\s+done|no[tn]e?\s+yet|skipped?|pending|outstanding|waived|to\s?do|n\/a|deferred|will\s+run)\b/iu;
const NEGATIVE = /\b(?:failed?|blocked|rejected|findings?\s+open|open\s+findings?|unresolved)\b/iu;
const POSITIVE =
  /\b(?:no\s+findings?|findings?\s+closed|all\s+closed|closed\b|passed?|clean|approved)\b/iu;

/** 'absent' | 'negative' | 'positive' | 'unstated' */
const outcome = (line) => {
  if (ABSENT.test(line)) return 'absent';
  if (NEGATIVE.test(line)) return 'negative';
  if (POSITIVE.test(line)) return 'positive';
  return 'unstated';
};

const explain = {
  absent: 'says the review was not run',
  negative: 'says the review failed or left findings open',
  unstated: 'states no outcome, so it records that someone typed a heading',
};

const failures = [];

// --- rule 1: a checkpoint for this head ------------------------------------

const checkpoint = /Review checkpoint[\s\S]{0,600}?head:\s*([0-9a-f]{7,40})/iu.exec(body);

// Every code-review line, not the first. One good line does not excuse a
// later one saying the second pass was never run.
const codeReviewLines = [...body.matchAll(/code[- ]review\s*:?[^\n]*/giu)].map((m) => m[0]);
if (codeReviewLines.length === 0) {
  failures.push(
    'the pull request states no code-review outcome.\n' +
      '        Add a line: `Code review: no findings`, or the findings and their\n' +
      '        disposition. The checkpoint block says which revision was looked\n' +
      '        at; it does not say a review happened or what it concluded.',
  );
} else {
  for (const line of codeReviewLines) {
    const verdict = outcome(line);
    if (verdict === 'positive') continue;
    failures.push(
      `a code-review line ${explain[verdict]}:\n` +
        `          ${line.trim()}\n` +
        '        ADR 0046 requires an actual report, not a mention of one.',
    );
  }
}

if (checkpoint === null) {
  failures.push(
    'the pull request carries no review checkpoint block.\n' +
      '        Run `node scripts/review-preflight.mjs` and paste what it prints.\n' +
      '        See docs/agents/review-checkpoint.md.',
  );
} else {
  const recorded = checkpoint[1] ?? '';
  if (!head.startsWith(recorded) && !recorded.startsWith(head)) {
    failures.push(
      `the review checkpoint records head ${recorded}, and this pull request is\n` +
        `        at ${head}. A review of one revision is not a review of another.\n` +
        '        Run the checks and the review again, and paste the new block.',
    );
  }
}

// --- rule 2: a security review where the surface calls for one -------------

if (sensitive.length > 0) {
  const security = /security[- ]review[\s\S]{0,300}?([0-9a-f]{7,40})/iu.exec(body);
  if (security === null) {
    failures.push(
      'this change touches the sensitive surface and carries no security review:\n' +
        sensitive.map((f) => `          ${f}`).join('\n') +
        '\n        AGENTS.md requires one before any pull request touching auth,\n' +
        '        tenancy, tool execution, egress, custody or the audit chain.',
    );
  } else {
    const recorded = security[1] ?? '';
    if (!head.startsWith(recorded) && !recorded.startsWith(head)) {
      failures.push(
        `the security review records ${recorded}, and this pull request is at\n` +
          `        ${head}. Run it again against the current head.`,
      );
    }
    for (const line of [...body.matchAll(/security[- ]review\s*:?[^\n]*/giu)].map((m) => m[0])) {
      const verdict = outcome(line);
      if (verdict === 'positive') continue;
      failures.push(
        `a security review line ${explain[verdict]}:\n` +
          `          ${line.trim()}\n` +
          '        A change to this surface merges on a completed review, not on a\n' +
          '        line that mentions one.',
      );
    }
  }
}

console.log(`review-evidence: ${changed.length} changed file(s), ${sensitive.length} sensitive`);

if (failures.length > 0) {
  console.error(`\nreview-evidence: ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  console.error(
    'review-evidence: this check is what makes "nothing merges without green\n' +
      'review-evidence: checks" true rather than said. It is not a formality.',
  );
  process.exit(1);
}

console.log('review-evidence: the review covers this exact revision.');
