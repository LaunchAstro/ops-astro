#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// The command parity check and report (API-1). It scans the app's source for
// every command a screen calls, maps each file to its route through the screen
// registry's imports, builds the catalogue and holds the API, the CLI and the
// app to the owning commands. Source files only: no database, no network.
// `--check` exits 1 on any failure; `--json` prints the catalogue.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  COMMAND_SURFACE,
  VIEW_ONLY_EXEMPT,
  buildCatalogue,
  checkParity,
  profileOf,
  renderReport,
} from '../packages/core-wire/src/index.ts';
import { accepts } from '../apps/cli/client.ts';

const WEB = resolve(import.meta.dirname, '..', 'apps', 'web', 'src');
/** The web surface itself and the address tables: transport, not actions. */
const NOT_ACTIONS = new Set(['operations/client.ts', 'manifest.ts', 'routes.ts']);
const APP_SHELL = 'app shell';

/** Every source file under `root`, relative to it. */
function sources(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)));
}

/** The relative imports a file makes, resolved to paths relative to `root`. */
function importsOf(root, file, text) {
  return [...text.matchAll(/from\s+'(\.{1,2}\/[^']+)'/gu)].map((match) =>
    relative(root, resolve(dirname(join(root, file)), match[1])),
  );
}

/** Command names quoted in `text` whose namespace is one the surface declares. */
export function commandsIn(text, namespaces) {
  return [...text.matchAll(/'([a-z]+)\.([a-z_]+)'/gu)]
    .filter((match) => namespaces.has(match[1]))
    .map((match) => `${match[1]}.${match[2]}`);
}

/**
 * Every place the app calls a command. `files` maps a path relative to the
 * web source root to its text, so a test can plant one. A file no route's
 * screen imports is attributed to the app shell.
 */
export function scanUses(files, namespaces) {
  const registry = files.get('screen-registry.tsx') ?? '';
  const imported = new Map(
    [...registry.matchAll(/import\s+\{\s*(\w+)\s*\}\s+from\s+'\.\/([^']+)'/gu)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  const routeOf = new Map();
  for (const block of registry.split(/\n\s{2}'/u).slice(1)) {
    const route = block.slice(0, block.indexOf("'"));
    const queue = [...block.matchAll(/<(\w+)/gu)]
      .map((match) => imported.get(match[1]))
      .filter((file) => file !== undefined);
    const seen = new Set();
    while (queue.length > 0) {
      const file = queue.shift();
      if (seen.has(file) || !files.has(file)) continue;
      seen.add(file);
      routeOf.set(file, [...(routeOf.get(file) ?? []), route]);
      queue.push(...importsOf(WEB, file, files.get(file)));
    }
  }
  const uses = [];
  for (const [file, text] of files) {
    if (NOT_ACTIONS.has(file)) continue;
    for (const command of new Set(commandsIn(text, namespaces))) {
      for (const route of routeOf.get(file) ?? [APP_SHELL]) uses.push({ command, route, file });
    }
  }
  return uses;
}

/** What each real surface reaches: the API serves every row, the CLI what it accepts. */
export function realSurfaces(uses) {
  const served = new Map(COMMAND_SURFACE.map((one) => [one.name, profileOf(one)]));
  return {
    api: served,
    cli: new Map([...served].filter(([name]) => accepts(name))),
    // The app's client takes every surface name (`mutate()` and `read()`).
    web: served,
    ui: uses,
    exempt: VIEW_ONLY_EXEMPT,
  };
}

export function run(
  files = new Map(sources(WEB).map((file) => [file, readFileSync(join(WEB, file), 'utf8')])),
) {
  const namespaces = new Set(COMMAND_SURFACE.map((one) => one.name.split('.')[0]));
  const uses = scanUses(files, namespaces);
  const rows = buildCatalogue(uses);
  return { rows, failures: checkParity(rows, realSurfaces(uses)) };
}

if (process.argv[1] === import.meta.filename) {
  const { rows, failures } = run();
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  else process.stdout.write(renderReport(rows, failures));
  if (process.argv.includes('--check') && failures.length > 0) process.exitCode = 1;
}
