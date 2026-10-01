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
import { runRead } from '../packages/core-commands/src/reads/dispatch.ts';
import { createApi } from '../apps/api/app.ts';
import { createCli } from '../apps/cli/client.ts';
import { OperationsClient, READ_NAMES } from '../apps/web/src/operations/client.ts';

const WEB = resolve(import.meta.dirname, '..', 'apps', 'web', 'src');
// transport, addresses
const NOT_ACTIONS = new Set(['operations/client.ts', 'manifest.ts', 'routes.ts']);
// The only requests the app sends itself, each call exactly once; any other request fails.
const TRANSPORTS = new Map([
  // the commands' own client: a read, then a write
  [
    'operations/client.ts',
    ['this.#options.fetch(url, { headers, signal })', 'this.#options.fetch(url, {'],
  ],
  // signs a person in and out: a session, not a record
  [
    'session/sign-in.ts',
    ['request.fetch(url, {', 'request.fetch(`${request.apiOrigin}${path}`, {'],
  ],
  // asks where to sign in before there is a session, and hands the app its fetch
  ['main.tsx', ["window.fetch('/api/sign-in')", 'window.fetch.bind(window)']],
  // wraps that fetch for the sign-in address only, adding the public key: a session, not a record
  ['session/provider-key.ts', ['fetcher: typeof fetch', '): typeof fetch {', 'as typeof fetch']],
]);
// A named call keeps its shape and loses its request: `fetch` and `/api/` read as nothing. Its
// first occurrence in code counts; one on a comment line is passed over (at worst, a false alarm).
const inComment = (text, at) =>
  /\/\/|^\s*\*|\/\*/u.test(text.slice(text.lastIndexOf('\n', at) + 1, at));
const withoutNamed = (text, file) =>
  (TRANSPORTS.get(file) ?? []).reduce((rest, call) => {
    let at = rest.indexOf(call);
    while (at !== -1 && inComment(rest, at)) at = rest.indexOf(call, at + 1);
    if (at === -1) return rest;
    const named = call.replaceAll('fetch', 'named').replaceAll('/api/', '/');
    return rest.slice(0, at) + named + rest.slice(at + call.length);
  }, text);
const REQUEST_GLOBALS = new Set(['fetch', 'XMLHttpRequest', 'EventSource', 'WebSocket']);
const REQUEST_METHODS = new Set(['fetch', 'sendBeacon']);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self']);

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

const TYPES = new Set(['TsTypeAnnotation', 'TsTypeAliasDeclaration', 'TsInterfaceDeclaration']);

/** Every node of `file`, parsed by swc: comments are never code; `values` leaves types out. */
function nodesOf(text, file, values = false) {
  const nodes = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach((one) => walk(one));
    if (node === null || typeof node !== 'object') return;
    if (values && TYPES.has(node.type)) return;
    nodes.push(node);
    for (const key of Object.keys(node)) if (key !== 'span') walk(node[key]);
  };
  walk(parseSync(text, { syntax: 'typescript', tsx: file.endsWith('.tsx') }));
  return nodes;
}

const textOf = (node) =>
  node.type === 'StringLiteral'
    ? node.value
    : node.type === 'TemplateLiteral' && !(node.expressions ?? node.types)[0]
      ? node.quasis[0].cooked
      : undefined;

/** Command names among the string literals of `file`. */
export function commandsIn(text, namespaces, file = 'a.tsx') {
  return nodesOf(text, file)
    .map((node) => textOf(node))
    .filter((one) => /^[a-z]+\.[a-z_]+$/u.test(one ?? '') && namespaces.has(one.split('.')[0]));
}

/**
 * Whether `file` sends a request itself: a request global referenced (a bare identifier carries
 * `optional`; a property name or key does not) or read off `window`, `globalThis` or `self`,
 * `.fetch(` or `.sendBeacon(` called, or an API address.
 */
export function sendsDirectly(text, file = 'a.tsx') {
  return nodesOf(text, file, true).some((node) => {
    const method = node.type === 'CallExpression' ? node.callee.property : undefined;
    return (
      (node.type === 'Identifier' && 'optional' in node && REQUEST_GLOBALS.has(node.value)) ||
      (node.type === 'MemberExpression' &&
        GLOBAL_OBJECTS.has(node.object.value) &&
        REQUEST_GLOBALS.has(node.property.value ?? node.property.expression?.value)) ||
      REQUEST_METHODS.has(method?.value ?? method?.expression?.value) ||
      (textOf(node) ?? '').startsWith('/api/')
    );
  });
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
    let commands = [];
    try {
      if (sendsDirectly(withoutNamed(text, file), file)) {
        unparsed.push(`${file} sends a request itself, with no command or CLI verb`);
      }
      if (NOT_ACTIONS.has(file)) continue;
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

// Enough of each read's operands to reach its grant check; the family a plan names is the
// collection it asks. A read missing here is refused before the check and fails parity.
const OPERANDS = {
  'task.read': { recordId: 'r' },
  'task.execution': { recordId: 'r' },
  'task.board': { board: null },
  'task.receipt': { attemptId: 'a' },
  'preset.plan': { recordTypeKey: 'preset', presetKey: 'p', fields: [] },
};

// The grants a read really asks: the real read path on a transaction that holds none.
async function askedBy(read) {
  const asked = [];
  const spine = [
    { key: 'task', id: 't' },
    { key: 'task_state', id: 's' },
  ];
  const tx = {
    businessId: 'business',
    query: (sql, params) => {
      if (sql.includes('from effective e')) asked.push(`${params[0]}:${params[1]}`);
      return Promise.resolve(sql.includes('from record_types') ? spine : []);
    },
  };
  const session = { personId: 'p', actorId: 'a', roleKey: 'member' };
  await runRead(tx, session, { ...OPERANDS[read], read }).catch(() => null);
  return asked;
}

// What the real API runs at each path on both prefixes, profiled: a read by the grants its
// path asks, a command by its declaration (its executor stubbed).
async function routedByApi() {
  let ran;
  let asked;
  const command = (...args) => (
    (ran = args[4].command),
    Promise.resolve({ recordId: 'r', revision: 1 })
  );
  const api = createApi({
    database: {},
    verify: () => Promise.resolve({ subject: 'parity' }),
    resolveBusiness: () => Promise.resolve('business'),
    executeRead: async (...args) => ((ran = args[3].read), (asked = await askedBy(ran)), {}),
    executeCommand: command,
    executeAgentCommand: command,
  });
  const routed = new Map();
  for (const path of [...under(ROOT), ...under(AGENT)]) {
    ran = undefined;
    asked = undefined;
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
    // eslint-disable-next-line no-await-in-loop -- one route at a time, one recorded name
    await api.fetch(new Request(`http://parity${path}`, init));
    const name = ran;
    const runs = COMMAND_SURFACE.find((one) => one.name === name);
    if (runs === undefined) continue;
    routed.set(
      path,
      asked === undefined ? profileOf(runs) : { ...profileOf(runs), authority: asked },
    );
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
