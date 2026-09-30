// SPDX-License-Identifier: AGPL-3.0-only
// Review evidence, bound to the revision being merged (ADR 0046).
//
// 1. The pull request body carries the review checkpoint block from
//    scripts/review-preflight.mjs, and its head is the head being merged.
// 2. If the change touches the sensitive surface ADR 0046 names, the body
//    also carries a security review bound to the same head.
// 3. CQ-13, product issue 42: the body carries the record of the review by a
//    model from another company than the builder's, for this head, or, while
//    Sol's review is owed (owner, 1 October 2026), the `needs-sol` label and
//    a `Sol-owed:` line naming its row in stage1/SOL-OWED.md.
//
// It reads PR_BODY, PR_LABELS, HEAD_SHA, CHANGED_FILES and AGENT_MODELS so the same code
// runs in continuous integration and in its own tests. It reads no reviewer
// identity: a green result proves the evidence is bound to this exact head,
// not that any reviewer read anything.

import { execFileSync } from 'node:child_process';
import { readBody, unfiled } from './review-evidence-read.mjs';

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

const base = process.env['BASE_SHA'] ?? '';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const nonEmptyLines = (text) =>
  text
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
const changed = nonEmptyLines(
  process.env['CHANGED_FILES'] ??
    (base === ''
      ? ''
      : git('diff', '--name-only', `${git('merge-base', base, head).trim()}...${head}`)),
);

// The builder's models: every commit's `Agent-model:` trailer in the range.
const builders = (
  process.env['AGENT_MODELS'] ??
  (base === ''
    ? ''
    : git('log', '--format=%(trailers:key=Agent-model,valueonly)', `${base}..${head}`))
).split('\n');

const sensitive = changed.filter((f) => SENSITIVE.some((r) => r.test(f)));

// --- the grammar ----------------------------------------------------------

// The body as GitHub renders it (scripts/review-evidence-read.mjs).
const { stated, record, owed, buried, html, prose } = readBody(body);

// The literal strings the template ships with, named in the failure so the
// author knows which line they missed.
const PLACEHOLDERS = [
  'REPLACE-WITH-OUTCOME',
  '<head sha>',
  '<base sha>',
  'N findings, all closed',
  'Closes #123',
];

// The outcome is the whole text after the field name on that line, trimmed,
// case-insensitive, with one optional trailing full stop, and it must be one
// form of a closed grammar (round twelve: free-text rules each moved the
// hole). An explanation goes on the following lines, which are not read.
const SHA = String.raw`[0-9a-f]{7,40}`;
const COUNTED = String.raw`(?<raised>\d{1,4})\s+(?<noun>findings?),\s+(?:all|(?<closed>\d{1,4}))\s+closed`;

const CODE_FORMS = [
  /^no\s+findings$/u,
  /^the\s+review\s+found\s+nothing$/u,
  /^every\s+finding\s+it\s+raised\s+is\s+closed$/u,
  new RegExp(String.raw`^${COUNTED}$`, 'u'),
  // Issue 88: minor findings filed under standing permission, to an open issue.
  new RegExp(
    String.raw`^(?<raised>\d{1,4})\s+(?<noun>findings?),\s+(?<closed>\d{1,4})\s+closed,\s+(?<filed>\d{1,4})\s+filed\s+as\s+follow-up\s+#\d{1,7}$`,
    'u',
  ),
];
const RAN_FORMS = [
  new RegExp(String.raw`^run\s+against\s+${SHA},\s+no\s+findings$`, 'u'),
  new RegExp(String.raw`^run\s+against\s+${SHA},\s+${COUNTED}$`, 'u'),
];
// Only where the change touches no sensitive path; one fixed text, since a
// free reason read `not required: pending` as an answer (round thirteen).
const NOT_REQUIRED = /^not\s+required:\s+no\s+sensitive\s+paths\s+changed$/u;
const NOT_REQUIRED_HELP = 'not required: no sensitive paths changed';

const CODE_HELP = [
  'no findings',
  'the review found nothing',
  'every finding it raised is closed',
  '<N> findings, all closed',
  '<N> findings, <N> closed',
  '<N> findings, <M> closed, <K> filed as follow-up #<open issue>, M + K = N, K at least 1',
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
  const { raised, noun, closed, filed } = m.groups ?? {};
  if (raised === undefined) return true;
  const n = Number(raised);
  if (n < 1 || (noun === 'finding') !== (n === 1)) return false;
  if (filed !== undefined) return Number(filed) >= 1 && Number(closed) + Number(filed) === n;
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
  unfiled: 'names a follow-up that is not an open issue in this repository',
};

const failures = [];

// A recorded revision names this head when either is a prefix of the other,
// both read in lowercase (security review of d77b375, finding 3; round 14).
const current = head.toLowerCase();
const namesHead = (recorded) => current.startsWith(recorded) || recorded.startsWith(current);

// --- rule 1: a checkpoint for this head ------------------------------------

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
  const notFiled = await unfiled(codeReviewLines.map((f) => f.value));
  for (const field of codeReviewLines) {
    let verdict = outcome(field.value, CODE_FORMS);
    if (verdict === 'accepted' && notFiled.has(field.value)) verdict = 'unfiled';
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
  const recorded = (checkpoint[1] ?? '').toLowerCase();
  if (!namesHead(recorded)) {
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
    // Every security-review line, not the first one carrying a revision
    // (round eight): a later line naming an older revision is evidence for
    // that older revision only.
    for (const field of securityFields) {
      const match = /\b([0-9a-f]{7,40})\b/iu.exec(field.value);
      const recorded = match === null ? '' : (match[1] ?? '').toLowerCase();
      if (recorded === '') {
        failures.push(
          `a security review line states no revision, so nothing binds it to\n` +
            `        this pull request's head ${head}:\n` +
            `          ${field.line}\n` +
            '        Record the head it ran against.',
        );
      } else if (!namesHead(recorded)) {
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
  // Round eight: an unreplaced placeholder fails whatever the change touches.
  // Here the fixed `not required` text is accepted beside the ran forms.
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

// --- rule 3: the other company's review record for this head --------------

// CQ-13, product issue 42. Rules 1 and 2 read outcomes the author states. The
// record the cross-company reviewer posts, copied into the body, names the
// head it read, its model and its verdict. Every record line is read, as every
// security line is: a record for an older head is not evidence for this one.
//
// Sol's first CQ-13 review: a model may name its company first, as in
// `OpenAI/gpt-6-sol`; each part of the name is read. Every builder's company
// is refused, and a builder model of no known company fails, because no
// reviewer can then be shown to come from another company.
const COMPANY = [
  [/^(?:anthropic|claude|opus|sonnet|haiku|fable)\b/u, 'Anthropic'],
  [/^(?:openai|gpt|o\d|codex)\b/u, 'OpenAI'],
  [/^(?:google|gemini)\b/u, 'Google'],
];
const companiesOf = (model) =>
  model
    .trim()
    .toLowerCase()
    .split('/')
    .flatMap((part) => COMPANY.filter(([r]) => r.test(part.trim())).map(([, c]) => c));
const builtBy = new Set(builders.flatMap((b) => companiesOf(b)));
const unknownBuilders = builders.filter((b) => b.trim() !== '' && companiesOf(b).length === 0);
const refused = {
  reviewer: () => false,
  model: (v) => companiesOf(v).length === 0 || companiesOf(v).some((c) => builtBy.has(c)),
  'head sha': (v) => !current.startsWith(/^[0-9a-f]{7,40}\b/iu.exec(v)?.[0].toLowerCase() ?? '-'),
  verdict: (v) => !/^approve\.?$/iu.test(v),
};

// Owner, 1 October 2026: Sol is off the path until about 4 October, so the
// record may instead be an explicit owed mark. It holds only with the
// `needs-sol` label (PR_LABELS, one name per line), every `Sol-owed:` line in
// the closed form below, and no record line at all: a record beside it is read
// as before. Rules 1 and 2 are unchanged, so the code-review line and, on a
// sensitive path, the security review bound to this head are still required.
// A range ends at this head, as every other revision here names it; Sol, of
// OpenAI, is owed only for work no OpenAI model built (Opus review of b4ee1fa).
const OWED_FORM =
  /^stage1\/SOL-OWED\.md\s+(?:[0-9a-f]{7,40}\.\.(?<end>[0-9a-f]{7,40})|[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{1,4})$/u;
const OWED_HELP = 'Sol-owed: stage1/SOL-OWED.md <base sha>..<head sha> or <ROW-ID-N>';
const labelled = nonEmptyLines(process.env['PR_LABELS'] ?? '').includes('needs-sol');
const owedForm = (value) => {
  const m = OWED_FORM.exec(value.trim().replace(/\.$/u, '').trim());
  const end = m?.groups?.['end'];
  return m !== null && (end === undefined || namesHead(end));
};
for (const field of owed.filter((f) => !owedForm(f.value))) {
  failures.push(
    `a Sol-owed line is not the accepted form:\n          ${field.line}\n` +
      `        Write \`${OWED_HELP}\`, naming the row that holds this piece for Sol;\n` +
      '        a range ends at this head.',
  );
}
if (owed.length > 0 && !labelled) {
  failures.push(
    'the pull request carries a Sol-owed line and not the `needs-sol` label.\n' +
      '        The mark is both: add the label, or delete this line and copy in\n' +
      '        the review record.',
  );
}
if (owed.length > 0 && builtBy.has('OpenAI')) {
  failures.push(
    "the pull request marks Sol's review owed, and an OpenAI model built part of it.\n" +
      "        Sol cannot review its own company's work: copy in another company's record.",
  );
}
const owedMark =
  labelled &&
  !builtBy.has('OpenAI') &&
  owed.length > 0 &&
  owed.every((f) => owedForm(f.value)) &&
  Object.values(record).every((values) => values.length === 0);

const recordProblems = Object.entries(record).flatMap(([name, values]) =>
  owedMark
    ? []
    : values.length === 0
      ? [`no \`${name}:\` line`]
      : values
          .filter((v) => outcome(v, [/./u]) !== 'accepted' || refused[name](v))
          .map((v) => `${name}: ${v}`),
);
recordProblems.push(...unknownBuilders.map((b) => `Agent-model: ${b.trim()} (no known company)`));
if (recordProblems.length > 0) {
  failures.push(
    "the pull request carries no complete record of another company's review\n" +
      `        of this head:\n${recordProblems.map((p) => `          ${p}`).join('\n')}\n` +
      "        Copy the reviewer's four lines: `Head SHA:` this head, `Model:` from\n" +
      "        another company than the commits' `Agent-model:`, `Verdict: approve`.\n" +
      "        Or, while Sol's review is owed: the `needs-sol` label, no record lines,\n" +
      `        and a top-level line \`${OWED_HELP}\`.`,
  );
}

// --- rule 4: a review field counts only on a top-level plain line ---------

// CQ-13, Sol's fourth and fifth reviews: fail closed. Any line written or
// shown as a review field that is not a plain line of a top-level paragraph,
// at the margin, fails.
if (buried.length > 0) {
  failures.push(
    'a review field appears where it could be hidden:\n' +
      buried.map((b) => `          ${b}`).join('\n') +
      '\n        A review field counts only on a plain line of a top-level paragraph,\n' +
      '        at the margin: not in a list, quote, table, heading, HTML block,\n' +
      '        fence, code span or indented code. Move it to its own plain line.',
  );
}

// --- rule 5: no raw HTML -------------------------------------------------

// CQ-13, Sol's sixth review: a body is Markdown only. Any raw tag fails; a
// comment, a fence and a code span are allowed.
if (html.length > 0) {
  failures.push(
    `the pull request body holds raw HTML (${html[0]}):\n` +
      '        A body is Markdown only; an HTML comment is the one exception.\n' +
      '        Write the text in Markdown, or put a literal sample in a code span.',
  );
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
