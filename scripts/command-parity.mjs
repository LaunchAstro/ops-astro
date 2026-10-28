#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- the one parity check: the app's scan and the surfaces' probes */
// The command parity check and report (API-1), from sources: `--check` exits 1; `--json` prints it.

import { readdirSync, readFileSync, realpathSync } from 'node:fs';
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
import { prepareCommand } from '../packages/core-commands/src/commands/prepare.ts';
import { runRead } from '../packages/core-commands/src/reads/dispatch.ts';
import { createApi } from '../apps/api/app.ts';
import { createCli } from '../apps/cli/client.ts';
import { OperationsClient, READ_NAMES } from '../apps/web/src/operations/client.ts';
import { handoffFailures } from './command-handoffs.mjs';

export { handoffFailures } from './command-handoffs.mjs';

const WEB = resolve(import.meta.dirname, '..', 'apps', 'web', 'src');
// transport, addresses
const NOT_ACTIONS = new Set(['operations/client.ts', 'manifest.ts', 'routes.ts']);
// The only requests the app sends itself, each call exactly once; any other request fails.
const TRANSPORTS = new Map([
  // the commands' own client: a read, then a write
  [
    'operations/client.ts',
    ['this.#options.fetch(url, { ...init, headers })', 'this.#options.fetch(url, {'],
  ],
  // signs a person in and out: a session, not a record
  ['session/sign-in.ts', ['request.fetch(`${request.apiOrigin}${path}`, {']],
  // the password grant at the sign-in provider, which sign-in.ts, the CLI and the worker make
  ['session/password-grant.ts', ['request.fetch(url, {']],
  // signs out, at the provider, a new session the tab never adopted (C59): a session, not a record
  ['session/sign-in-again.ts', ['fetch: typeof globalThis.fetch,', 'fetch(url, {']],
  // asks where to sign in before there is a session, and hands the app its fetch
  ['main.tsx', ["window.fetch('/api/sign-in')", 'window.fetch.bind(window)']],
  // wraps that fetch for the sign-in address only, adding the public key: a session, not a record
  ['session/provider-key.ts', ['fetcher: typeof fetch', '): typeof fetch {', 'as typeof fetch']],
  // accepts an invitation, signed out, on its one-time link: the token is the authority, no command
  [
    'screens/Enrol.tsx',
    [
      "ENROL_API_PATH = '/api/enrol'",
      'fetch: typeof globalThis.fetch;',
      'props.fetch(`${props.apiOrigin}${ENROL_API_PATH}`, {',
    ],
  ],
]);
// A named call keeps its shape and loses its request: `fetch` and `/api/` read as nothing. Its
// first occurrence in code counts; one after `//` or a `/*` still open on its line, or on a
// comment line, is passed over (at worst, a false alarm).
const inComment = (text, at) => {
  const line = text.slice(text.lastIndexOf('\n', at) + 1, at);
  return /\/\/|^\s*\*/u.test(line) || line.lastIndexOf('/*') > line.lastIndexOf('*/');
};
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
 * `optional`; a property name or key does not), read off `window`, `globalThis` or `self`, or
 * taken out of an object under any name, `.fetch(` or `.sendBeacon(` called, or an API address.
 */
export function sendsDirectly(text, file = 'a.tsx') {
  return nodesOf(text, file, true).some((node) => {
    const method = node.type === 'CallExpression' ? node.callee.property : undefined;
    const taken = node.type === 'KeyValuePatternProperty' ? node.key : undefined;
    return (
      (node.type === 'Identifier' && 'optional' in node && REQUEST_GLOBALS.has(node.value)) ||
      [REQUEST_GLOBALS, REQUEST_METHODS].some((names) =>
        names.has(taken?.value ?? taken?.expression?.value),
      ) ||
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
  'task.ledger': { before: null, timeZone: 'Australia/Brisbane', query: null },
  'definition.attribution': { digest: 'a'.repeat(64) },
  'trace.read': { recordId: 'r' },
  'map.view': { recordId: 'r' },
  'map.frontier': { recordId: 'r' },
  'map.list': {},
  'live_correction.read': { correctionId: 'c' },
  'live_correction.list': {},
  'live_correction.receipts': { correctionId: 'c' },
  'review.read': { reviewId: 'r' },
  'review.list': {},
  'review.picture': { pictureId: 'r' },
  'review.client_list': {},
  'privacy.draft_breach_notices': {
    incidentId: '00000000-0000-4000-8000-000000000000',
    oaic: { name: 'o', address: 'a' },
    people: [{ name: 'p', address: 'a' }],
    containment: 'c',
    steps: 's',
  },
  'chat.messages': { conversationId: '00000000-0000-4000-8000-000000000000' },
  'automation.history': { activationId: '00000000-0000-4000-8000-000000000000' },
  'finance.agent_costs': { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' },
};

// The grants a command really asks, on a transaction that holds none: a read by its real read
// path, a write by its real preparation (prepare.ts; the handler not run). Preparation asks a
// write's own key, or none when self-scoped, and with no grant held refuses for that; its handler
// asks any other its declaration names.
async function askedBy(declaration) {
  const asked = [];
  const spine = [
    { key: 'task', id: 't' },
    { key: 'task_state', id: 's' },
  ];
  const tx = {
    businessId: 'business',
    query: (sql, params) => {
      // Only the grant check names a collection and action ($1, $2); a client list asks no key.
      if (sql.includes('where e.collection = $1')) asked.push(`${params[0]}:${params[1]}`);
      return Promise.resolve(sql.includes('from record_types') ? spine : []);
    },
  };
  const session = { personId: 'p', actorId: 'a', roleKey: 'member' };
  const { name, kind, authorisedOn, collection, action } = declaration;
  if (kind === 'read') {
    await runRead(tx, session, { ...OPERANDS[name], read: name }).catch(() => null);
    return asked;
  }
  const prepared = await prepareCommand(tx, session, 'api', { command: name }, declaration).catch(
    () => null,
  );
  const own = authorisedOn === 'self' ? '' : `${collection}:${action}`;
  // A grant is checked only if holding none refuses here: a query that admits anyway checks
  // nothing, so the write reports no key and its declared one reads as skipped. A later refusal
  // (an operand this probe leaves out) proves nothing.
  if (own !== '' && prepared?.refusal?.code !== 'SCOPE_NOT_GRANTED') return [];
  return asked.join() === own ? profileOf(declaration).authority : asked;
}

// What the real API runs at each path on both prefixes, by name and the grants it asks. Every
// executor call is kept, bearer by bearer: a path runs one command once for each bearer it
// takes, the agent prefix a session's and an agent credential's (API-2).
async function routedByApi() {
  const calls = [];
  const execute = (...args) => {
    calls.push(args.at(-1).read ?? args.at(-1).command);
    return Promise.resolve({ recordId: 'r', revision: 1 });
  };
  const api = createApi({
    database: {},
    verify: () => Promise.resolve({ subject: 'parity' }),
    resolveBusiness: () => Promise.resolve('business'),
    executeRead: execute,
    executeCommand: execute,
    executeAgentCommand: execute,
    executeCredentialCommand: execute,
  });
  const routed = new Map();
  for (const path of [...under(ROOT), ...under(AGENT)]) {
    const bearers = ['parity.probe.token', ...(path.startsWith(AGENT) ? ['c'.repeat(43)] : [])];
    const ran = [];
    for (const bearer of bearers) {
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${bearer}` };
      // eslint-disable-next-line no-await-in-loop -- one route at a time, its calls recorded
      await api.fetch(new Request(`http://parity${path}`, { method: 'POST', headers, body: '{}' }));
      ran.push(calls.splice(0));
    }
    // Each bearer runs the one command exactly once: a count shared between them hides one
    // that runs it twice beside one that never does.
    const name = ran[0]?.[0];
    const runs = COMMAND_SURFACE.find((one) => one.name === name);
    if (runs === undefined || ran.some((one) => one.length !== 1 || one[0] !== name)) continue;
    // eslint-disable-next-line no-await-in-loop -- one route at a time
    const authority = await askedBy(runs);
    routed.set(path, { name: runs.name, profile: { ...profileOf(runs), authority } });
  }
  return routed;
}
const ROUTED = await routedByApi();

// Each name sent through a surface (clients post before any await) reaches its path's profile
// only when the API runs that very command there; a path that runs another reaches nothing.
function reached(send) {
  const reach = new Map();
  for (const { name } of COMMAND_SURFACE) {
    let path;
    send(name, (sent) => ((path = sent), Promise.resolve(new Response('{}')))).catch(() => null);
    const routed = ROUTED.get(path);
    if (routed?.name === name) reach.set(name, routed.profile);
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
  const failures = [...unparsed, ...checkParity(rows, realSurfaces(uses)), ...handoffFailures()];
  return { rows, failures };
}

// The entry point by real path, so a checkout under a space or reached through a link still runs.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  const { rows, failures } = run();
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  else process.stdout.write(renderReport(rows, failures));
  if (process.argv.includes('--check') && failures.length > 0) process.exitCode = 1;
}
