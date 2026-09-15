// SPDX-License-Identifier: AGPL-3.0-only
// The pull request size gate.
//
// Warn at 300 changed lines, block at 400. The ceiling is not arbitrary:
// past about that size, review stops finding defects, and a reviewer who
// cannot really review is worse than no reviewer at all.
//
// Two waivers, each a label, each needing a reason written on the pull
// request. Two anti-gaming rules come with them: a per-file cap, and the
// requirement that a split names the invariant test that only passes once
// every part has landed. The second one is a human check at merge; this
// script does the first.
//
// The rule is written for people in CONTRIBUTING.md. This file must agree
// with it.

import { execFileSync } from 'node:child_process';

const WARN_AT = 300;
const BLOCK_AT = 400;
const PER_FILE_CAP = 400;

const MECHANICAL_LABEL = 'size-waiver-mechanical';
const COHERENCE_LABEL = 'size-waiver-coherence';

// Files a human did not hand-write. They still count towards the total,
// because a reviewer still has to look at the pull request, but they do not
// trip the per-file cap.
const GENERATED = [
  /(^|\/)pnpm-lock\.yaml$/u,
  /(^|\/)package-lock\.json$/u,
  /(^|\/)yarn\.lock$/u,
  /(^|\/)LICENSE$/u,
  /\.snap$/u,
  /(^|\/)dist\//u,
  /\.generated\.[a-z]+$/u,
];

const base = process.env.BASE_SHA;
const head = process.env.HEAD_SHA;
const labels = (process.env.PR_LABELS ?? '')
  .split(',')
  .map((l) => l.trim())
  .filter(Boolean);

if (!base || !head) {
  console.error('pr-size: BASE_SHA and HEAD_SHA must both be set.');
  process.exit(2);
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8' });

// The merge base, not the base branch tip, or every commit that landed on
// main since the branch started would be counted against the author.
const mergeBase = git(['merge-base', base, head]).trim();
const numstat = git(['diff', '--numstat', mergeBase, head]).trim();

const files = [];
let total = 0;

for (const line of numstat ? numstat.split('\n') : []) {
  const [addedRaw, deletedRaw, ...pathParts] = line.split('\t');
  const path = pathParts.join('\t');
  // A binary file shows as "-\t-\t<path>".
  const added = addedRaw === '-' ? 0 : Number(addedRaw);
  const deleted = deletedRaw === '-' ? 0 : Number(deletedRaw);
  const changed = added + deleted;
  total += changed;
  files.push({ path, changed, generated: GENERATED.some((r) => r.test(path)) });
}

const hasMechanical = labels.includes(MECHANICAL_LABEL);
const hasCoherence = labels.includes(COHERENCE_LABEL);
const waived = hasMechanical || hasCoherence;

const annotate = (level, message) => console.log(`::${level}::${message}`);

console.log(`pr-size: ${total} changed lines across ${files.length} file(s).`);
console.log(`pr-size: warn at ${WARN_AT}, block at ${BLOCK_AT}, per-file cap ${PER_FILE_CAP}.`);
if (labels.length > 0) console.log(`pr-size: labels: ${labels.join(', ')}`);

const failures = [];

if (total > BLOCK_AT) {
  if (waived) {
    const which = hasMechanical ? MECHANICAL_LABEL : COHERENCE_LABEL;
    annotate(
      'warning',
      `This pull request is ${total} changed lines, over the ${BLOCK_AT} line ceiling, ` +
        `and is allowed through by ${which}. The reason must be written on the pull request.`,
    );
  } else {
    failures.push(
      `${total} changed lines is over the ${BLOCK_AT} line ceiling. Split it, or apply ` +
        `${MECHANICAL_LABEL} or ${COHERENCE_LABEL} with a reason. If you split it, name the ` +
        `invariant test that only passes once every part has landed. See CONTRIBUTING.md.`,
    );
  }
} else if (total >= WARN_AT) {
  annotate(
    'warning',
    `This pull request is ${total} changed lines. The ceiling is ${BLOCK_AT}. Consider splitting it.`,
  );
}

// The per-file cap. **No label lifts it.**
//
// Round four found the mechanical waiver lifting this as well as the total,
// so one label let a single unreadable file through. The two limits exist for
// different reasons: the total is about how much a reviewer can hold in one
// sitting, and the per-file cap is about a file nobody can read at all. A
// genuinely generated file is caught by its pattern below without anyone
// applying a label, which is the honest route. If a file is generated and its
// pattern is missing, add the pattern.
for (const file of files) {
  if (file.changed <= PER_FILE_CAP) continue;
  if (file.generated) {
    annotate(
      'warning',
      `${file.path} changes ${file.changed} lines, over the per-file cap of ${PER_FILE_CAP}, ` +
        'allowed because it matches a generated-file pattern.',
    );
    continue;
  }
  failures.push(
    `${file.path} changes ${file.changed} hand-written lines, over the per-file cap of ` +
      `${PER_FILE_CAP}. Splitting the pull request without splitting this file does not help ` +
      'a reviewer, and no label lifts this cap. If the file is generated, add its pattern ' +
      'to GENERATED in this script rather than labelling around it.',
  );
}

if (failures.length > 0) {
  for (const failure of failures) annotate('error', failure);
  process.exit(1);
}

console.log('pr-size: within the rule.');
