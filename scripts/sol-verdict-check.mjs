// SPDX-License-Identifier: AGPL-3.0-only
// Usage: node scripts/sol-verdict-check.mjs --records <directory>
// PR_NUMBER, HEAD_SHA and PR_LABELS come from merge-group.mjs. The directory
// holds paginated comments.json and reviews.json. SOL_REVIEWER_ACCOUNT is a
// repository variable, never taken from the pull request's text.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBody } from './review-evidence-read.mjs';

const fail = (message) => {
  console.error(`::error::sol-verdict: #${process.env.PR_NUMBER ?? '?'}: ${message}`);
  process.exit(1);
};

if (!(process.env.PR_LABELS ?? '').split('\n').includes('needs-sol')) {
  console.log(`#${process.env.PR_NUMBER}: not applicable`);
  process.exit(0);
}

const account = process.env.SOL_REVIEWER_ACCOUNT ?? '';
const head = process.env.HEAD_SHA ?? '';
if (!/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/iu.test(account))
  fail('SOL_REVIEWER_ACCOUNT must name the configured GitHub reviewer login.');
if (!/^[0-9a-f]{40}$/u.test(head)) fail('HEAD_SHA must be a full 40-character head.');
const [flag, dir, ...extra] = process.argv.slice(2);
if (flag !== '--records' || !dir || extra.length > 0) fail('use --records <directory>.');

try {
  const records = ['comments', 'reviews'].flatMap((kind) => {
    const response = JSON.parse(readFileSync(join(dir, `${kind}.json`), 'utf8'));
    if (!Array.isArray(response)) throw new Error(`${kind} is not an array`);
    return response.map((record) => ({ record, kind }));
  });
  const candidates = [];
  for (const { record, kind } of records) {
    if (record.user?.login?.toLowerCase() !== account.toLowerCase()) continue;
    const read = readBody(record.body ?? '');
    if (
      !read.record.reviewer.includes('Sol (Codex)') &&
      !(record.body ?? '').includes('Reviewer: Sol (Codex)')
    )
      continue;
    // Both sources carry their current update time. REST reviews omit it, so
    // the workflow obtains formal review timestamps and bodies via GraphQL.
    const stamp = record.updated_at;
    const time = typeof stamp === 'string' ? Date.parse(stamp) : NaN;
    if (!Number.isFinite(time)) fail('a candidate record has an unreadable timestamp.');
    candidates.push({ record, read, time, kind });
  }
  candidates.sort((a, b) => b.time - a.time);
  const newest = candidates[0];
  if (newest === undefined) fail('no record from the configured account names the exact identity.');
  if (candidates[1]?.time === newest.time) fail('the newest records have an ambiguous timestamp.');
  const { record, read, kind } = newest;
  if (record.state === 'DISMISSED') fail('the newest review was dismissed.');
  if (
    read.buried.length > 0 ||
    read.html.length > 0 ||
    read.record.reviewer.length !== 1 ||
    read.record.reviewer[0] !== 'Sol (Codex)' ||
    read.record['head sha'].length !== 1 ||
    read.record['head sha'][0] !== head ||
    read.record.verdict.length !== 1 ||
    read.record.verdict[0] !== 'approve'
  )
    fail('the newest record must contain one plain identity, exact full head and approve verdict.');
  console.log(`#${process.env.PR_NUMBER}: pass, newest ${kind} record covers ${head}`);
} catch (error) {
  fail(`cannot read verdict records: ${error.message}`);
}
