// SPDX-License-Identifier: AGPL-3.0-only
// Every Action pinned to a commit, and every pin written down.
//
// Finding 20 of the sweep of 6 September had two halves. The download half is
// fixed in the workflow itself: the gitleaks archive is verified against a
// published digest before anything is extracted. This is the other half.
//
// A full commit hash is sound syntax. It is not verification: a hash proves
// only that the bytes have not changed since somebody wrote the hash down,
// and says nothing about whether the right thing was written down. So the
// repository keeps a record of where each pin came from and how it was
// checked, and this script fails when a workflow and that record disagree.
//
// Two rules:
//   1. Every `uses:` in .github/workflows is pinned to a 40 character commit
//      hash. A tag can be moved; a hash cannot.
//   2. Every pin appears in docs/supply-chain-pins.md. A pin nobody recorded
//      is a pin nobody verified.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const workflowDir = join(repoRoot, '.github', 'workflows');
const recordPath = join(repoRoot, 'docs', 'supply-chain-pins.md');

const USES = /^\s*-?\s*uses:\s*([^\s#]+)/gmu;
const PINNED = /^(?<action>[^@]+)@(?<sha>[0-9a-f]{40})$/u;

const failures = [];
const pins = new Map();

if (!existsSync(workflowDir)) {
  console.error(`pins: no workflow directory at ${workflowDir}`);
  process.exit(2);
}

const workflows = readdirSync(workflowDir).filter((f) => /\.ya?ml$/u.test(f));
if (workflows.length === 0) {
  console.error('pins: no workflows found; this check would pass vacuously.');
  process.exit(2);
}

for (const file of workflows) {
  const text = readFileSync(join(workflowDir, file), 'utf8');
  for (const match of text.matchAll(USES)) {
    const ref = match[1];
    if (ref === undefined) continue;
    if (ref.startsWith('./') || ref.startsWith('docker://')) continue;
    const pinned = PINNED.exec(ref);
    if (pinned?.groups === undefined) {
      failures.push(
        `${file}: ${ref} is not pinned to a 40 character commit hash.\n` +
          '        A tag can be moved by whoever owns it. A hash cannot.',
      );
      continue;
    }
    pins.set(ref, `${file}`);
  }
}

console.log(`pins: ${pins.size} pinned action reference(s) across ${workflows.length} workflow(s)`);

if (!existsSync(recordPath)) {
  failures.push(
    'docs/supply-chain-pins.md does not exist.\n' +
      '        Every pin needs a record of where it came from and how it was\n' +
      '        checked. A pin nobody recorded is a pin nobody verified.',
  );
} else {
  const record = readFileSync(recordPath, 'utf8');
  for (const [ref, where] of pins) {
    const sha = ref.split('@')[1] ?? '';
    if (!record.includes(sha)) {
      failures.push(
        `${where}: ${ref} is not in docs/supply-chain-pins.md.\n` +
          '        Record the tag it corresponds to and how that was checked.',
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`\npins: ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}

console.log('pins: every action is pinned to a hash, and every pin is recorded.');
