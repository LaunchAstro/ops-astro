#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// The command parity check and report (API-1), from source files only.
// `--check` exits 1 on any failure; `--json` prints the catalogue.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseSync } from '@swc/core';
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
import { createApi } from '../apps/api/app.ts';
import { createCli } from '../apps/cli/client.ts';
import { OperationsClient, READ_NAMES } from '../apps/web/src/operations/client.ts';

const WEB = resolve(import.meta.dirname, '..', 'apps', 'web', 'src');
// transport, addresses
const NOT_ACTIONS = new Set(['operations/client.ts', 'manifest.ts', 'routes.ts']);

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

/** Command names among the string literals of `file`, parsed by swc: comments are never code. */
export function commandsIn(text, namespaces, file = 'a.tsx') {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach((one) => walk(one));
    if (node === null || typeof node !== 'object') return;
    if (node.type === 'StringLiteral') found.push(node.value);
    if (node.type === 'TemplateLiteral' && !node.expressions[0]) found.push(node.quasis[0].cooked);
    for (const key of Object.keys(node)) if (key !== 'span') walk(node[key]);
  };
  walk(parseSync(text, { syntax: 'typescript', tsx: file.endsWith('.tsx') }));
  return found.filter((one) => /^[a-z]+\.[a-z_]+$/u.test(one) && namespaces.has(one.split('.')[0]));
}

/** Every place the app calls a command; a file no route's screen imports is the app shell's. */
export function scanUses(files, namespaces, unparsed = []) {
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
    let commands = [];
    try {
      commands = commandsIn(text, namespaces, file);
    } catch {
      // Fails closed: a file that cannot be read for commands fails the check.
      unparsed.push(`${file} does not parse, so its commands cannot be checked`);
    }
    for (const command of new Set(commands)) {
      for (const route of routeOf.get(file) ?? ['app shell']) uses.push({ command, route, file });
    }
  }
  return uses;
}

const [ROOT, AGENT] = [`${PREFIX.person}b`, `${PREFIX.agent}b`];
const under = (root) => COMMAND_SURFACE.map((one) => root + pathOf(one.name));

// What the real API runs at each path on both prefixes, recorded by stub executors, profiled.
async function routedByApi() {
  let ran;
  const command = (...args) => (
    (ran = args[4].command),
    Promise.resolve({ recordId: 'r', revision: 1 })
  );
  const api = createApi({
    database: {},
    verify: () => Promise.resolve({ subject: 'parity' }),
    resolveBusiness: () => Promise.resolve('business'),
    executeRead: (...args) => ((ran = args[3].read), Promise.resolve({})),
    executeCommand: command,
    executeAgentCommand: command,
  });
  const routed = new Map();
  for (const path of [...under(ROOT), ...under(AGENT)]) {
    ran = undefined;
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
    // eslint-disable-next-line no-await-in-loop -- one route at a time, one recorded name
    await api.fetch(new Request(`http://parity${path}`, init));
    const name = ran;
    const runs = COMMAND_SURFACE.find((one) => one.name === name);
    if (runs !== undefined) routed.set(path, profileOf(runs));
  }
  return routed;
}
const ROUTED = await routedByApi();

// Each name sent through a surface (clients post before any await) is what the API runs there.
function reached(send) {
  const reach = new Map();
  for (const { name } of COMMAND_SURFACE) {
    let path;
    send(name, (sent) => ((path = sent), Promise.resolve(new Response('{}')))).catch(() => null);
    if (ROUTED.has(path)) reach.set(name, ROUTED.get(path));
  }
  return reach;
}

const app = (fetch) => new OperationsClient({ origin: '', businessKey: 'b', token: null, fetch });
export function realSurfaces(uses) {
  return {
    api: reached((name, post) => post(`${ROOT}${pathOf(name)}`)),
    agent: reached((name, post) => post(`${AGENT}${pathOf(name)}`)),
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
  const unparsed = [];
  const uses = scanUses(files, namespaces, unparsed);
  const rows = buildCatalogue(uses);
  return { rows, failures: [...unparsed, ...checkParity(rows, realSurfaces(uses))] };
}

if (process.argv[1] === import.meta.filename) {
  const { rows, failures } = run();
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  else process.stdout.write(renderReport(rows, failures));
  if (process.argv.includes('--check') && failures.length > 0) process.exitCode = 1;
}
