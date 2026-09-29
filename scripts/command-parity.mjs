#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// The command parity check and report (API-1), from source files only.
// `--check` exits 1 on any failure; `--json` prints the catalogue.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  COMMAND_SURFACE,
  PREFIX,
  VIEW_ONLY_EXEMPT,
  buildCatalogue,
  checkParity,
  pathOf,
  profileOf,
  renderReport,
} from '../packages/core-wire/src/index.ts';
import { createCli } from '../apps/cli/client.ts';
import { OperationsClient, READ_NAMES } from '../apps/web/src/operations/client.ts';

const WEB = resolve(import.meta.dirname, '..', 'apps', 'web', 'src');
/** The web surface itself and the address tables: transport, not actions. */
const NOT_ACTIONS = new Set(['operations/client.ts', 'manifest.ts', 'routes.ts']);
const APP_SHELL = 'app shell';

function sources(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)));
}

function importsOf(root, file, text) {
  return [...text.matchAll(/from\s+'(\.{1,2}\/[^']+)'/gu)].map((match) =>
    relative(root, resolve(dirname(join(root, file)), match[1])),
  );
}

/** Command names quoted in `text`, in any of the three quotes, whose namespace the surface declares. */
export function commandsIn(text, namespaces) {
  // Comments name commands in backticks; only code calls them.
  const code = text.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/(^|[^:])\/\/.*$/gmu, '$1');
  return [...code.matchAll(/(['"`])([a-z]+)\.([a-z_]+)\1/gu)]
    .filter((match) => namespaces.has(match[2]))
    .map((match) => `${match[2]}.${match[3]}`);
}

/** Every place the app calls a command; a file no route's screen imports is the app shell's. */
export function scanUses(files, namespaces) {
  const registry = files.get('screen-registry.tsx') ?? '';
  const named = registry.matchAll(/import\s+\{\s*(\w+)\s*\}\s+from\s+'\.\/([^']+)'/gu);
  const imported = new Map(Array.from(named, (match) => [match[1], match[2]]));
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

const SERVED = new Map(COMMAND_SURFACE.map((one) => [pathOf(one.name), profileOf(one)]));
const ROOT = `${PREFIX.person}b`;

// What a client reaches: each name goes through the real client, which posts
// before its first await, and is profiled as the endpoint served at the path it
// sent, so a redirected verb meets that route's grant. Sending nothing reaches nothing.
function reached(send) {
  const reach = new Map();
  for (const { name } of COMMAND_SURFACE) {
    let path;
    const record = (sent) => {
      path = sent;
      return Promise.resolve(new Response('{}'));
    };
    send(name, record).catch(() => null);
    const profile = path?.startsWith(ROOT) ? SERVED.get(path.slice(ROOT.length)) : undefined;
    if (profile !== undefined) reach.set(name, profile);
  }
  return reach;
}

const app = (fetch) => new OperationsClient({ origin: '', businessKey: 'b', token: null, fetch });

/** What each real surface reaches, and the grant asked where it lands. */
export function realSurfaces(uses) {
  return {
    // The API mounts one route per row (`apps/api/app.ts`).
    api: new Map(COMMAND_SURFACE.map((one) => [one.name, profileOf(one)])),
    cli: reached((name, transport) =>
      createCli({ businessKey: 'b', credential: 'unused', transport }).run(name, {}),
    ),
    web: reached((name, fetch) =>
      READ_NAMES.includes(name) ? app(fetch).read(name, {}) : app(fetch).mutate(name, {}),
    ),
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
