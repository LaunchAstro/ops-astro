// SPDX-License-Identifier: AGPL-3.0-only
// One rule, checked: nothing merges itself.
//
// Finding 8 of the sweep of 6 September. CONTRIBUTING.md says checks never
// merge anything by themselves and AGENTS.md says merge is a human decision,
// while renovate.json enabled automatic merging of development dependency
// patches. A build tool can change shipped output, so "only a dev dependency"
// is not a reason to skip the person.
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
          '        CONTRIBUTING.md says checks never merge anything by themselves\n' +
          '        and AGENTS.md says merge is a human decision. Either turn this\n' +
          '        off, or change both documents and say why in an ADR.',
      );
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
