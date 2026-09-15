// SPDX-License-Identifier: AGPL-3.0-only
// The build. There is nothing to build.
//
// This script exists so `pnpm build` is a real command from commit one:
// continuous integration runs it, and the day a package appears the build
// becomes real without the workflow changing.
//
// It refuses to be quiet about the situation. Nothing in this repository is
// built, and a build script that printed "done" would be the first lie in
// the tree.

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['packages', 'apps'];
const buildable = [];

for (const root of roots) {
  if (!existsSync(root)) continue;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (existsSync(join(root, entry.name, 'package.json'))) {
      buildable.push(`${root}/${entry.name}`);
    }
  }
}

if (buildable.length === 0) {
  console.log('build: nothing to build. No package in the tree has a package.json.');
  console.log('build: this foundation has no application implementation. See README.md.');
  process.exit(0);
}

console.error('build: packages exist but this script has not been taught to build them:');
for (const name of buildable) console.error(`  ${name}`);
console.error('build: teach it in the ticket that adds the first package.');
process.exit(1);
