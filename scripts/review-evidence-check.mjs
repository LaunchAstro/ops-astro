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
//
// What it does not do, and the pull request template says so too: it reads no
// reviewer identity. A green result proves the evidence is bound to this exact
// head. It does not prove that any reviewer read anything.
//
// Round seven, 17 September, found the check passing a body that was the
// template byte for byte with only the checkpoint filled: the outcome fields
// were still the template's own instructional HTML comments, and the words
// "no findings" inside one of them read as an outcome. The same substring
// search failed a correct body that cited
// .claude/skills/_shared/security-review.md by path, because the filename
// read as a second field with no verdict in it. Both are the same defect:
// a substring search over prose is not a grammar. So:
//
//   - HTML comments are removed before anything is parsed;
//   - the two outcome fields are anchored to the start of a line, so a
//     mention of a review in a sentence is a mention and not a field;
//   - the template's literal placeholders are refused by name.

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

// --- the grammar ----------------------------------------------------------

// An HTML comment is instruction to the author, never evidence. Removing it
// first is what stops the template's own prose from answering for the author.
const stripComments = (text) => text.replaceAll(/<!--[\s\S]*?-->/gu, ' ');

// The literal strings the template ships with. An unreplaced one is named in
// the failure rather than reported as "no outcome stated", because the author
// needs to know which line they missed.
const PLACEHOLDERS = [
  'REPLACE-WITH-OUTCOME',
  '<head sha>',
  '<base sha>',
  'N findings, all closed',
  'Closes #123',
];

// A field is a line that begins with the field name. `Code review:` at the
// start of a line is an answer; "the code review found nothing" inside a
// sentence, or a path ending in security-review.md, is not.
const FIELD =
  /^[ \t]*(?:[-*+][ \t]+)?\*{0,2}(code|security)[ -]review\*{0,2}[ \t]*:[ \t]*(.*)$/gimu;

/** Every occurrence of a field, in order, as {name, value, line}. */
const fields = (text) => {
  FIELD.lastIndex = 0;
  return [...text.matchAll(FIELD)].map((m) => ({
    name: (m[1] ?? '').toLowerCase(),
    value: (m[2] ?? '').trim(),
    line: m[0].trim(),
  }));
};

// Did the review happen, and what did it conclude?
//
// Round five found this check matching the words "security review" and a
// hash, so a body saying the review was NOT RUN, with the current hash beside
// it, passed. Matching text is not establishing that a review happened. A
// reviewer states an outcome, and there are only three kinds.
//
// Round eight, 23 September, found two halves of one defect. `Code review:
// not approved` passed, because `approved` was matched as a bare substring
// with nothing reading the word in front of it, so a rejected review received
// green evidence. And `Code review: the review found nothing`, the wording
// the pull request template advertises as passing, failed, because that
// phrasing was on no list: the template and the parser disagreed about a
// valid outcome. So the outcome words are an alternation anchored on word
// boundaries, longest phrase first, a negator in front of one turns it into a
// rejection, and the template's own advertised wordings are on the list.
//
// Refusals and absences come first: a line that says both "not run" and "no
// findings" is a contradiction, and the safe reading of a contradiction is
// the one that does not authorise a merge.
const ABSENT =
  /\b(?:not\s+run|not\s+performed|not\s+done|no[tn]e?\s+yet|skipped?|pending|outstanding|waived|to\s?do|n\/a|deferred|will\s+run)\b/iu;
// Round eleven, 24 September, found the counting reading only `findings` and
// `closed`, so `approved with 2 issues; 1 closed` and `2 findings; 1
// resolved` passed. Every noun a reviewer raises and every verb that closes
// one is read the same way, in the negative, positive and counting rules.
const NOUN = String.raw`(?:findings?|issues?|problems?|blockers?|concerns?)`;
const CLOSURE = String.raw`(?:closed|resolved|fixed|addressed)`;

const NEGATIVE = new RegExp(
  String.raw`\b(?:failed?|blocked|rejected|${NOUN}\s+open|(?<!\bno\s+)open\s+${NOUN}|unresolved)\b`,
  'iu',
);

// The same round found `approved subject to resolving 1 finding` passing on
// `approved`. An approval that waits on something is not a final outcome,
// wherever the condition sits on the line.
const CONDITIONAL =
  /\b(?:subject\s+to|pending|once|after|if|provided|providing|unless|until|conditional(?:ly)?|on\s+condition|contingent)\b/iu;

// The words a reviewer uses for a clean result. The multi-word phrases come
// first so the longest one wins: `no findings` is read whole, rather than as
// a negator sitting in front of something else.
const POSITIVE_WORDS = [
  String.raw`no\s+(?:open\s+)?(?:findings?|issues?|problems?|blockers?|concerns?)`,
  String.raw`(?:found|raised|turned\s+up|reported)\s+nothing`,
  String.raw`nothing\s+(?:was\s+)?(?:found|raised)`,
  String.raw`${NOUN}\s+(?:are\s+)?(?:all\s+)?${CLOSURE}`,
  String.raw`(?:all|both)\s+(?:${NOUN}\s+)?${CLOSURE}`,
  String.raw`(?:is|are)\s+${CLOSURE}`,
  CLOSURE,
  String.raw`passe[sd]`,
  String.raw`pass(?:ing)?`,
  String.raw`clean`,
  String.raw`approved?`,
  String.raw`green`,
].join('|');

// A word that reverses the one after it. `no` is on this list as well, and
// `no findings` survives it, because that phrase is matched as one positive
// word before `no` is ever read on its own.
const NEGATOR = String.raw`(?:not|never|no|isn['\u2019]?t|wasn['\u2019]?t|aren['\u2019]?t|cannot)`;

// Round nine, 23 September, found the negation narrower than the grammar it
// was meant to reverse. `not all findings are closed` and `not fully
// approved` both passed, because the negator had to sit directly against the
// positive word and here it does not: one word of English between them was
// enough to turn a rejection green. So the negator reaches across up to three
// words. Punctuation is the boundary, and deliberately: `approved, no
// findings` is two clauses, and the negator in the second has no business
// reversing the first.
const GAP = String.raw`[ \t-]{1,3}(?:\w+[ \t-]{1,3}){0,3}`;

const NEGATED = new RegExp(String.raw`\b${NEGATOR}${GAP}(?:${POSITIVE_WORDS})\b`, 'iu');

// Round ten, 24 September, found that bound was itself the way through: `not
// in any way fully approved` puts four words between the negator and the
// approval, and `not, in any way, approved` puts commas there. Any reach is a
// number an author can exceed. So a line holding a negator anywhere reads as a
// rejection, once the positive phrases that carry their own `no` are taken
// out. `approved, no findings` still passes; `approved; not blocking` now
// fails, and the author says it without the negator. A false refusal costs a
// rewording, a false approval costs a merge.
const SELF_NEGATING = new RegExp(String.raw`\bno\s+(?:open\s+)?${NOUN}\b`, 'giu');
const BARE_NEGATOR = new RegExp(String.raw`\b${NEGATOR}\b`, 'iu');
const negated = (value) =>
  NEGATED.test(value) || BARE_NEGATOR.test(value.replace(SELF_NEGATING, ' '));
const POSITIVE = new RegExp(
  String.raw`(?<!\b${NEGATOR}[ \t-]{1,3})\b(?:${POSITIVE_WORDS})\b`,
  'iu',
);

// The same round found the other half: a disposition that closes some of the
// findings and not the rest. `2 findings, 1 closed` carries no negator at
// all, and `closed` read on its own is an approval. A count of closed
// findings is a clean outcome only when it accounts for every finding raised,
// so the two numbers are compared rather than the word being taken alone.
// `3 findings, all closed` says so in words and still passes.
const COUNT = String.raw`\d{1,4}|zero|one|two|three|four|five|six|seven|eight|nine|ten`;
const WORD_NUMBERS = new Map(
  ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].map(
    (w, i) => [w, i],
  ),
);
const count = (token) => {
  const text = String(token ?? '').toLowerCase();
  return /^\d+$/u.test(text) ? Number(text) : (WORD_NUMBERS.get(text) ?? Number.NaN);
};

// `1 of 3 closed`, and `2 findings ... 1 closed`. Round ten, 24 September,
// found the gap between them stopping at a sentence boundary, so `2 findings.
// 1 closed` was read as two sentences and passed on `closed`. A line is one
// disposition, so every count raised and every count closed on it is
// compared, wherever it stands: any closed count short of any raised count is
// partial. `1 of them closed` states a closed count against the raised one.
const CLOSED_OF = new RegExp(
  String.raw`\b(${COUNT})\s+(?:of|out\s+of)\s+(?:the\s+)?(${COUNT}|them|these|those)\b[\s\S]*?\b${CLOSURE}\b`,
  'giu',
);
const RAISED = new RegExp(String.raw`\b(${COUNT})\s+(?:open\s+)?${NOUN}\b`, 'giu');
const CLOSED_COUNT = new RegExp(
  String.raw`\b(${COUNT})\s+(?:${NOUN}\s+)?(?:(?:is|are|were|was|(?:has|have)\s+been)\s+)?${CLOSURE}\b`,
  'giu',
);
// A disposition that says in words that it is incomplete.
const SOME_CLOSED = new RegExp(
  String.raw`\b(?:some|most|partly|partially|a\s+few|several|the\s+rest|the\s+remainder|remaining)\b[\s\S]*?\b${CLOSURE}\b`,
  'iu',
);
// A disposition that says in words that it is complete.
const ALL_CLOSED = new RegExp(String.raw`\b(?:all|every|each|both)\b[\s\S]*?\b${CLOSURE}\b`, 'iu');
const MENTIONS = new RegExp(String.raw`\b${NOUN}\b`, 'iu');

const counts = (pattern, value, group) =>
  [...value.matchAll(pattern)].map((m) => count(m[group])).filter((n) => !Number.isNaN(n));

const partial = (value) => {
  if (SOME_CLOSED.test(value)) return true;
  const raised = [...counts(RAISED, value, 1), ...counts(CLOSED_OF, value, 2)];
  const closed = [...counts(CLOSED_COUNT, value, 1), ...counts(CLOSED_OF, value, 1)];
  return closed.some((c) => raised.some((r) => c < r));
};

// Sol's recheck asked for the durable shape: a line that raises findings
// passes only on an explicit disposition closing all of them. Mentioning a
// finding at all, outside `no findings` and its kin, obliges the line to say
// every one is closed, in words (`all`, `every`, `both`) or in counts that
// reach the number raised. `approved with some issues` says neither.
const closesAll = (value) => {
  const text = value.replace(SELF_NEGATING, ' ');
  if (!MENTIONS.test(text) || ALL_CLOSED.test(text)) return true;
  const raised = [...counts(RAISED, text, 1), ...counts(CLOSED_OF, text, 2)];
  const closed = [...counts(CLOSED_COUNT, text, 1), ...counts(CLOSED_OF, text, 1)];
  if (raised.length > 0 && raised.every((r) => r === 0)) return true;
  return raised.length > 0 && closed.length > 0;
};

/**
 * 'placeholder' | 'empty' | 'absent' | 'negative' | 'conditional' | 'partial' |
 * 'unclosed' | 'positive' | 'unstated'
 */
const outcome = (value) => {
  if (PLACEHOLDERS.some((p) => value.toLowerCase().includes(p.toLowerCase()))) return 'placeholder';
  if (value === '') return 'empty';
  if (ABSENT.test(value)) return 'absent';
  if (NEGATIVE.test(value)) return 'negative';
  if (negated(value)) return 'negative';
  if (CONDITIONAL.test(value)) return 'conditional';
  if (partial(value)) return 'partial';
  if (!closesAll(value)) return 'unclosed';
  if (POSITIVE.test(value)) return 'positive';
  return 'unstated';
};

const explain = {
  placeholder: 'still carries a template placeholder, so nobody replaced it with an outcome',
  empty: 'is empty, so it records that someone typed a heading',
  absent: 'says the review was not run',
  negative: 'says the review failed or left findings open',
  conditional: 'approves on a condition, so it is not a final outcome',
  partial: 'closes some of the findings it raised and not the rest',
  unclosed: 'mentions findings without saying that every one is closed',
  unstated: 'states no outcome, so it records that someone typed a heading',
};

const failures = [];

// --- rule 1: a checkpoint for this head ------------------------------------

const prose = stripComments(body);
const stated = fields(prose);

const checkpoint = /Review checkpoint[\s\S]{0,600}?head:\s*([0-9a-f]{7,40})/iu.exec(prose);

// Every code-review field, not the first. One good line does not excuse a
// later one saying the second pass was never run.
const codeReviewLines = stated.filter((f) => f.name === 'code');
if (codeReviewLines.length === 0) {
  failures.push(
    'the pull request states no code-review outcome.\n' +
      '        Add a line: `Code review: no findings`, or the findings and their\n' +
      '        disposition. The checkpoint block says which revision was looked\n' +
      '        at; it does not say a review happened or what it concluded.',
  );
} else {
  for (const field of codeReviewLines) {
    const verdict = outcome(field.value);
    if (verdict === 'positive') continue;
    failures.push(
      `a code-review line ${explain[verdict]}:\n` +
        `          ${field.line}\n` +
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

const securityFields = stated.filter((f) => f.name === 'security');

if (sensitive.length > 0) {
  if (securityFields.length === 0) {
    failures.push(
      'this change touches the sensitive surface and carries no security review:\n' +
        sensitive.map((f) => `          ${f}`).join('\n') +
        '\n        AGENTS.md requires one before any pull request touching auth,\n' +
        '        tenancy, tool execution, egress, custody or the audit chain.',
    );
  } else {
    // Every security-review line, not the first one carrying a revision.
    // Round eight found a body holding a review for this head followed by
    // another for the base passing, because the search stopped at the first
    // match. A later line naming an older revision is evidence for that older
    // revision, and this check exists to say exactly that.
    for (const field of securityFields) {
      const match = /\b([0-9a-f]{7,40})\b/u.exec(field.value);
      const recorded = match === null ? '' : (match[1] ?? '');
      if (recorded === '') {
        failures.push(
          `a security review line states no revision, so nothing binds it to\n` +
            `        this pull request's head ${head}:\n` +
            `          ${field.line}\n` +
            '        Record the head it ran against.',
        );
      } else if (!head.startsWith(recorded) && !recorded.startsWith(head)) {
        failures.push(
          `a security review line records ${recorded}, and this pull request is\n` +
            `        at ${head}:\n` +
            `          ${field.line}\n` +
            '        Run it again against the current head.',
        );
      }
      const verdict = outcome(field.value);
      if (verdict === 'positive') continue;
      failures.push(
        `a security review line ${explain[verdict]}:\n` +
          `          ${field.line}\n` +
          '        A change to this surface merges on a completed review, not on a\n' +
          '        line that mentions one.',
      );
    }
  }
} else {
  // The template ships both outcome lines as the same placeholder and asks
  // for both to be replaced. Round eight found an unreplaced security
  // placeholder passing on a change that touched no sensitive path, because
  // placeholders were read only where a security review was required. An
  // author who has not replaced the line has not read it, whatever the change
  // touches. The surface still decides whether a review was needed: saying
  // plainly that it was not is an answer, and passes here.
  for (const field of securityFields) {
    if (outcome(field.value) !== 'placeholder') continue;
    failures.push(
      `a security review line ${explain.placeholder}:\n` +
        `          ${field.line}\n` +
        '        The template asks for both outcome lines to be replaced. This\n' +
        '        change touches no sensitive path, so say that on the line.',
    );
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

console.log(
  'review-evidence: the review evidence is bound to this exact revision.\n' +
    'review-evidence: it reads no reviewer identity, so this does not establish\n' +
    'review-evidence: that any reviewer read anything.',
);
