// SPDX-License-Identifier: AGPL-3.0-only
// The build: it builds what is built, and names what is not.
//
// `pnpm build` has been a real command since commit one. For most of that time
// there was nothing to build and it said so. There is now: `apps/web` is a Vite
// application, and this script runs that application's own `vite build` and
// propagates its exit status. It does not summarise the child, wrap it, or
// interpret it -- the child's output goes to this terminal and the child's
// status becomes this script's status.
//
// What this build is not, stated here because a build script that lets a reader
// assume more than it does is the same lie as one that prints "done":
//
//   - `apps/api` is not built. It runs as TypeScript source under Node 24's own
//     type stripping (scripts/local/api-up.sh line 31 execs `node server.ts`).
//     There is no compile step between the file on disk and the process serving
//     requests, so there is nothing here for a build to produce.
//   - `packages/ui` and `packages/core-records` are not built. They are consumed
//     from source -- the web app aliases `@launchastro/ui` to
//     `packages/ui/src/index.ts` (apps/web/vite.config.ts) and Rollup compiles
//     that source into the web bundle. A package with no build step is reported
//     as having none rather than given a no-op that reads like success.
//   - Packaging and deployment are a separate step this build does not claim.
//     A browser bundle in `apps/web/dist` is not a container image, not a
//     release artefact, and not a deployed service. Nothing here publishes
//     anything.
//
// A build that reports success without an artefact is the failure this script
// exists to catch, so each built target's output directory is checked for real
// files afterwards and an empty one fails.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** Workspace roots, in the order `pnpm-workspace.yaml` globs them. */
const ROOTS = ['packages', 'apps'];

/** Where a built target puts its output, relative to the target directory. */
const OUTPUT_DIRECTORY = { '@launchastro/web': 'dist' };

/**
 * Run a root package script through the same pnpm that is running this file.
 * Under corepack there may be no `pnpm` on PATH at all, which is why this
 * reads `npm_execpath` rather than trusting the name -- the same reason
 * scripts/check.mjs does.
 */
function pnpmRun(args) {
  const execPath = process.env['npm_execpath'];
  const isScript = execPath !== undefined && /\.[cm]?js$/u.test(execPath);
  const command = execPath === undefined ? 'pnpm' : isScript ? process.execPath : execPath;
  const prefix = isScript && execPath !== undefined ? [execPath] : [];
  return spawnSync(command, [...prefix, ...args], { stdio: 'inherit' });
}

/** Every directory under the workspace roots, classified by what it can build. */
function survey() {
  const targets = [];
  for (const root of ROOTS) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!entry.isDirectory()) continue;
      const directory = join(root, entry.name);
      const manifestPath = join(directory, 'package.json');
      if (!existsSync(manifestPath)) {
        // Not a workspace package: no manifest, so pnpm does not see it and
        // there is nothing to invoke. Its TypeScript is compiled by whoever
        // imports it.
        targets.push({ directory, name: null, kind: 'source' });
        continue;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const name = manifest.name ?? directory;
      const build = manifest.scripts?.['build'];
      targets.push(
        build === undefined
          ? { directory, name, kind: 'no-build-step' }
          : { directory, name, kind: 'build', command: build },
      );
    }
  }
  return targets;
}

const targets = survey();
const built = targets.filter((target) => target.kind === 'build');

console.log('build: what this build covers');
for (const target of targets) {
  if (target.kind === 'build') {
    console.log(`  build       ${target.directory} (${target.name}): \`${target.command}\``);
  } else if (target.kind === 'no-build-step') {
    console.log(`  no build    ${target.directory} (${target.name}): consumed from source`);
  } else {
    console.log(`  source      ${target.directory}: no package.json; consumed from source`);
  }
}
console.log('build: apps/api is not built. It runs as TypeScript source under Node 24');
console.log('build:   (scripts/local/api-up.sh execs `node apps/api/server.ts`).');
console.log('build: packaging and deployment are a separate step this build does not claim.');

if (built.length === 0) {
  console.log('build: no workspace package declares a build script. Nothing was built.');
  process.exit(0);
}

for (const target of built) {
  console.log(`\n=== ${target.name} (pnpm --filter ${target.name} run build) ===`);
  const run = pnpmRun(['--filter', target.name, 'run', 'build']);
  if (run.error !== undefined) {
    console.error(`build: could not run the build for ${target.name}: ${run.error.message}`);
    process.exit(1);
  }
  if (run.signal !== null && run.signal !== undefined) {
    console.error(`build: ${target.name} was killed by ${run.signal}.`);
    process.exit(1);
  }
  if (run.status !== 0) {
    console.error(`\nbuild: ${target.name} failed. Its build exited ${run.status}.`);
    process.exit(run.status);
  }

  // The child said it succeeded. A build that reports success with no artefact
  // is worse than one that fails, so the artefact is checked rather than
  // assumed.
  const output = OUTPUT_DIRECTORY[target.name];
  if (output === undefined) continue;
  const outputPath = join(target.directory, output);
  const contents = existsSync(outputPath) ? readdirSync(outputPath) : [];
  if (contents.length === 0) {
    console.error(`\nbuild: ${target.name} exited 0 but ${outputPath} is empty or absent.`);
    process.exit(1);
  }
  console.log(`build: ${target.name} wrote ${contents.length} entries to ${outputPath}`);
}

console.log(`\nbuild: built ${built.length} of ${targets.length} workspace directories.`);
console.log('build: nothing was packaged, released or deployed.');
