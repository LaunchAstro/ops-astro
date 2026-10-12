// SPDX-License-Identifier: AGPL-3.0-only
// One rule, checked: nothing merges itself.
//
// Finding 8 of the sweep of 6 September. CONTRIBUTING.md then said checks
// never merge anything by themselves and AGENTS.md said merge was a human
// decision, while renovate.json enabled automatic merging of development
// dependency patches. A build tool can change shipped output, so "only a dev
// dependency" is not a reason to skip the merge decision. ADR 0046, amended
// 23 September, has an agent invoke the merge on a green head; automatic
// merging stays disabled, so this rule stands.
//
// Documentation that contradicts configuration is worse than either alone: a
// reader believes the documentation and the machine obeys the configuration.
// So the rule is a check.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const failures = [];

const renovatePath = join(repoRoot, 'renovate.json');
let renovate;
try {
  renovate = JSON.parse(readFileSync(renovatePath, 'utf8'));
} catch (error) {
  console.error(`merge-policy: cannot read renovate.json: ${String(error)}`);
  process.exit(2);
}

// Presets checked to turn no automatic merging on. Renovate resolves a preset
// when it runs, which this check cannot, so any other is refused until it is
// read and added here.
const CHECKED_PRESETS = new Set(['config:recommended', ':semanticCommits']);

const walk = (node, path) => {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => walk(child, `${path}[${i}]`));
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    const here = path === '' ? key : `${path}.${key}`;
    if ((key === 'automerge' || key === 'platformAutomerge') && value === true) {
      failures.push(
        `renovate.json: ${here} is true.\n` +
          '        ADR 0046 disables all automatic merging: a named actor invokes\n' +
          '        each merge on a green head (CONTRIBUTING.md, who invokes the\n' +
          '        merge). Either turn this off, or amend ADR 0046 and say why.',
      );
    }
    if (key === 'extends') {
      for (const preset of [value].flat().filter((name) => !CHECKED_PRESETS.has(name))) {
        failures.push(
          `renovate.json: ${here} extends ${JSON.stringify(preset)}, a preset this check\n` +
            '        has not read. A preset can turn automatic merging on without\n' +
            '        `true` appearing here. Read it, then add it to CHECKED_PRESETS.',
        );
      }
    }
    walk(value, here);
  }
};

walk(renovate, '');

console.log('merge-policy: checked renovate.json for automatic merging');

if (failures.length > 0) {
  console.error(`\nmerge-policy: ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}

console.log('merge-policy: nothing merges itself.');
