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
  /^\.husky\//u, // the hooks that enforce the gate
  /^\.github\/workflows\//u, // what runs with repository credentials
  // The governance gates themselves. The security review of d77b375, finding
  // 1, 24 September: only the contamination gate counted, so a pull request
  // that changed only this checker, or the database runner and its manifest,
  // or pins-check, passed with `not required`. A gate decides what merges; a
  // change to one is a change to that decision.
  /^scripts\//u, // every checker CI and `pnpm check` run, and the runner itself
  /^tests\/(?:agents|branding|ci|db|gate|licences)\//u, // their own cases, and the database suite manifest
  /^package\.json$/u, // the scripts CI calls by name
  /^pnpm-(?:lock|workspace)\.yaml$/u, // what installs, and which install scripts run
  /^\.dependency-cruiser\.cjs$/u, // the dependency cruise's rules
  /^commitlint\.config\.js$/u, // the commit-message gate's rules
  /^\.gitleaks\.toml$/u, // the secrets scan's rules
  /^vitest\.config\.ts$/u, // how the database gate's suites run
  /^docs\/supply-chain-pins\.md$/u, // the record pins-check holds every pin to
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
// An unclosed comment runs to the end of the body, as GitHub renders it: the
// security review of d77b375, finding 2, found a line the merger never sees
// read as the only outcome. Everything after an unclosed `<!--` is hidden.
const stripComments = (text) => text.replaceAll(/<!--[\s\S]*?(?:-->|$)/gu, ' ');

// Fenced code is shown as code, not as a field. Copilot on PR A: a body whose
// only outcome sat inside a fenced sample passed, because fields were read on
// every line. Lines from an opening fence to its closing fence are blanked
// before fields are read, and an unclosed fence runs to the end of the body,
// as GitHub renders it. The checkpoint block, which the template ships inside
// a fence, is still read from the whole body. A fence may follow the same
// quote and list markers a field may.
const FENCE = /^[ \t]*(?:(?:>|[-*+]|\d{1,9}[.)])[ \t]*)*(`{3,}|~{3,})(.*)$/u;
const stripFences = (text) => {
  let open = '';
  return text
    .split('\n')
    .map((line) => {
      const m = FENCE.exec(line);
      if (open === '') {
        if (m !== null) open = m[1] ?? '';
        return open === '' ? line : '';
      }
      const run = m?.[1] ?? '';
      if (run[0] === open[0] && run.length >= open.length && (m?.[2] ?? '').trim() === '') {
        open = '';
      }
      return '';
    })
    .join('\n');
};

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
//
// Any Markdown line prefix still leaves a line that begins with the field
// name. The security review of d77b375, finding 2: a contradicting line
// written as a heading, a blockquote or a numbered item was not read, though
// GitHub shows it as an ordinary field line. So any run of heading marks,
// quote marks, list bullets, list numbers and checklist boxes may come first,
// and bold or underscore emphasis may wrap the name, the colon or the line.
// Sol's recheck of 356dbe5 added the checklist box and emphasis closing after
// the colon: `- [ ] Security review: rejected` was not read, and
// `**Security review:** run against <head>, no findings` read as `** run …`.
//
// Each prefix token matches a run one way only. The security rerun at 356dbe5,
// N1: `#{1,6}` with optional space between tokens split a line of `#` every
// possible way, and 40 of them took 41.8 s. `#+(?!#)` takes the whole run as
// one token, so a line of any length is read in linear time, and seven or
// more `#` still lead a field rather than hiding it.
const FIELD =
  /^[ \t]*(?:(?:#+(?!#)|>|[-*+]|\d{1,9}[.)]|\[[ x]\])[ \t]*)*[*_]{0,3}(code|security)[ -]review[*_]{0,3}[ \t]*:[ \t]*[*_]{0,3}[ \t]*(.*)$/gimu;

/** Every occurrence of a field, in order, as {name, value, line}. */
const fields = (text) => {
  FIELD.lastIndex = 0;
  return [...text.matchAll(FIELD)].map((m) => ({
    name: (m[1] ?? '').toLowerCase(),
    // Emphasis closing at the end of the line wraps the outcome, not part of it.
    value: (m[2] ?? '').replace(/[ \t]*[*_]+$/u, '').trim(),
    line: m[0].trim(),
  }));
};

// Did the review happen, and what did it conclude?
//
// Rounds five to eleven read the outcome as free text: substrings, then
// negators, then counts, conditions and closure verbs. Each round's rule
// moved the hole rather than closing it. Sol's recheck of 526a4c8 still
// passed `changes requested; all tests passed` and `2 findings; all
// addressed except one`. Round twelve, 24 September (lead ruling, Sol's
// "require an explicit review disposition"), stops reading English. The
// outcome is the whole text after the field name on that line, trimmed,
// case-insensitive, with one optional trailing full stop, and it must be one
// form of a closed grammar. Anything else fails. An explanation goes on the
// following lines, which this check does not read.
const SHA = String.raw`[0-9a-f]{7,40}`;
const COUNTED = String.raw`(?<raised>\d{1,4})\s+(?<noun>findings?),\s+(?:all|(?<closed>\d{1,4}))\s+closed`;

const CODE_FORMS = [
  /^no\s+findings$/u,
  /^the\s+review\s+found\s+nothing$/u,
  /^every\s+finding\s+it\s+raised\s+is\s+closed$/u,
  new RegExp(String.raw`^${COUNTED}$`, 'u'),
];
const RAN_FORMS = [
  new RegExp(String.raw`^run\s+against\s+${SHA},\s+no\s+findings$`, 'u'),
  new RegExp(String.raw`^run\s+against\s+${SHA},\s+${COUNTED}$`, 'u'),
];
// Only where the change touches no sensitive path. Round thirteen, 24
// September: a free reason read `not required: pending` and a rejected
// review as answers, so the form is one fixed text.
const NOT_REQUIRED = /^not\s+required:\s+no\s+sensitive\s+paths\s+changed$/u;
const NOT_REQUIRED_HELP = 'not required: no sensitive paths changed';

const CODE_HELP = [
  'no findings',
  'the review found nothing',
  'every finding it raised is closed',
  '<N> findings, all closed',
  '<N> findings, <N> closed',
];
const RAN_HELP = [
  'run against <sha>, no findings',
  'run against <sha>, <N> findings, all closed',
  'run against <sha>, <N> findings, <N> closed',
];
const help = (forms) =>
  '        The accepted forms, with N the same number, at least 1, and\n' +
  '        `finding` for 1:\n' +
  forms.map((f) => `          ${f}`).join('\n') +
  '\n        Put any explanation on the next line.\n';

/** A counted form states one number of findings raised and closes them all. */
const countsAgree = (m) => {
  const { raised, noun, closed } = m.groups ?? {};
  if (raised === undefined) return true;
  const n = Number(raised);
  if (n < 1 || (noun === 'finding') !== (n === 1)) return false;
  return closed === undefined || Number(closed) === n;
};

const accepts = (forms, text) =>
  forms.some((form) => {
    const m = form.exec(text);
    return m !== null && countsAgree(m);
  });

// Refusals the grammar rejects anyway, kept for the more specific message.
const ABSENT =
  /\b(?:not\s+run|not\s+performed|not\s+done|no[tn]e?\s+yet|skipped?|pending|outstanding|waived|to\s?do|n\/a|deferred|will\s+run)\b/iu;
const NEGATIVE = /\b(?:failed?|blocked|rejected|findings?\s+open|open\s+findings?|unresolved)\b/iu;

/** 'accepted' | 'placeholder' | 'empty' | 'absent' | 'negative' | 'unaccepted' */
const outcome = (value, forms) => {
  const text = value.trim().replace(/\.$/u, '').trim().toLowerCase();
  if (PLACEHOLDERS.some((p) => text.includes(p.toLowerCase()))) return 'placeholder';
  if (text === '') return 'empty';
  if (accepts(forms, text)) return 'accepted';
  if (ABSENT.test(text)) return 'absent';
  if (NEGATIVE.test(text)) return 'negative';
  return 'unaccepted';
};

const explain = {
  placeholder: 'still carries a template placeholder, so nobody replaced it with an outcome',
  empty: 'is empty, so it records that someone typed a heading',
  absent: 'says the review was not run',
  negative: 'says the review failed or left findings open',
  unaccepted: 'is not one of the accepted outcome forms',
};

const failures = [];

// --- rule 1: a checkpoint for this head ------------------------------------

const prose = stripComments(body);
const stated = fields(stripFences(prose));

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
    const verdict = outcome(field.value, CODE_FORMS);
    if (verdict === 'accepted') continue;
    failures.push(
      `a code-review line ${explain[verdict]}:\n` +
        `          ${field.line}\n` +
        (verdict === 'unaccepted' ? help(CODE_HELP) : '') +
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
  // The security review of d77b375, finding 3: the checkpoint head was read
  // ignoring case and compared with it, so an uppercase head was a false red.
  // Both sides in lowercase, as the security line has been since round
  // fourteen.
  const recorded = (checkpoint[1] ?? '').toLowerCase();
  const current = head.toLowerCase();
  if (!current.startsWith(recorded) && !recorded.startsWith(current)) {
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
        '        tenancy, tool execution, egress, custody or the audit chain, and\n' +
        '        a change to a governance gate is a change to what may merge.',
    );
  } else {
    // Every security-review line, not the first one carrying a revision.
    // Round eight found a body holding a review for this head followed by
    // another for the base passing, because the search stopped at the first
    // match. A later line naming an older revision is evidence for that older
    // revision, and this check exists to say exactly that.
    for (const field of securityFields) {
      // Round fourteen, 24 September: the outcome is matched ignoring case,
      // and the revision was read case-sensitively, so a head written in
      // uppercase hex read as none. Both sides are compared in lowercase.
      const match = /\b([0-9a-f]{7,40})\b/iu.exec(field.value);
      const recorded = match === null ? '' : (match[1] ?? '').toLowerCase();
      const current = head.toLowerCase();
      if (recorded === '') {
        failures.push(
          `a security review line states no revision, so nothing binds it to\n` +
            `        this pull request's head ${head}:\n` +
            `          ${field.line}\n` +
            '        Record the head it ran against.',
        );
      } else if (!current.startsWith(recorded) && !recorded.startsWith(current)) {
        failures.push(
          `a security review line records ${recorded}, and this pull request is\n` +
            `        at ${head}:\n` +
            `          ${field.line}\n` +
            '        Run it again against the current head.',
        );
      }
      const verdict = outcome(field.value, RAN_FORMS);
      if (verdict === 'accepted') continue;
      failures.push(
        `a security review line ${explain[verdict]}:\n` +
          `          ${field.line}\n` +
          (verdict === 'unaccepted' ? help(RAN_HELP) : '') +
          '        A change to this surface merges on a completed review, not on a\n' +
          '        line that mentions one.',
      );
    }
  }
} else {
  // Copilot on PR A, C10: a body with no security line at all passed here,
  // so deleting the line was less strict than leaving its placeholder.
  if (securityFields.length === 0) {
    failures.push(
      'the pull request states no security-review outcome.\n' +
        '        The template asks for both outcome lines to be replaced. This\n' +
        `        change touches no sensitive path, so write\n` +
        `        \`Security review: ${NOT_REQUIRED_HELP}\`.`,
    );
  }
  // The template ships both outcome lines as the same placeholder and asks
  // for both to be replaced. Round eight found an unreplaced security
  // placeholder passing on a change that touched no sensitive path, because
  // placeholders were read only where a security review was required. An
  // author who has not replaced the line has not read it, whatever the change
  // touches. The surface still decides whether a review was needed: here the
  // fixed `not required: no sensitive paths changed` is accepted, and since
  // round twelve a security line on this surface is held to the grammar too.
  for (const field of securityFields) {
    const verdict = outcome(field.value, [...RAN_FORMS, NOT_REQUIRED]);
    if (verdict === 'accepted') continue;
    failures.push(
      `a security review line ${explain[verdict]}:\n` +
        `          ${field.line}\n` +
        (verdict === 'unaccepted' ? help([...RAN_HELP, NOT_REQUIRED_HELP]) : '') +
        '        The template asks for both outcome lines to be replaced. This\n' +
        `        change touches no sensitive path, so \`${NOT_REQUIRED_HELP}\` is\n` +
        '        an answer.',
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
