// SPDX-License-Identifier: AGPL-3.0-only
//
// The documented-order suite's harness (local-seed-documented-order.test.ts):
// the README's start command as steps, a scratch checkout to run them from,
// the stand-in identity service, and the steps run in order.

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
import { serverUrl } from './staging-no-production-data.fixture.ts';

const repo = resolve(import.meta.dirname, '../..');

interface Step {
  readonly script: string;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The README's start command as its steps. Every part is
 * `[NAME=value ...] corepack pnpm <script>`, or this throws.
 */
function documentedSteps(): Step[] {
  const readme = readFileSync(join(repo, 'docs/local/README.md'), 'utf8');
  const section = readme.split(/^## /mu).find((part) => part.startsWith('Start it\n'));
  const block = section?.match(/^```\n([\s\S]*?)\n```$/mu)?.[1];
  if (block === undefined) throw new Error('docs/local/README.md: no "Start it" command block');
  return block
    .replaceAll('\\\n', ' ')
    .split('&&')
    .map((part) => {
      const step = part.trim().match(/^((?:[A-Z_]+=[^\s=]+\s+)*)corepack pnpm ([a-z:]+)$/u);
      if (step === null) throw new Error(`docs/local/README.md: not a start step: ${part.trim()}`);
      const env = (step[1] ?? '')
        .trim()
        .split(/\s+/u)
        .filter(Boolean)
        .map((pair) => pair.split('=') as [string, string]);
      return { script: step[2]!, env: Object.fromEntries(env) };
    });
}

/** The node script a package script runs, or this throws. */
function scriptFile(script: string): string {
  const scripts = (
    JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  const file = scripts[script]?.match(/^node (\S+)$/u)?.[1];
  if (file === undefined) throw new Error(`package.json: ${script} is not one node script`);
  return file;
}

export interface World {
  db?: FreshDatabase;
  readonly root: string;
  readonly identity: Server;
  readonly identityUrl: string;
}

/** The stand-in identity service: each created login is a row in `auth.users`. */
async function identityService(
  owner: () => FreshDatabase,
): Promise<{ server: Server; url: string }> {
  const users: { id: string; email: string }[] = [];
  /** One admin call's answer, and the sign-in row it writes. */
  const answer = async (method: string, path: string, body: string): Promise<[number, unknown]> => {
    if (method === 'GET') return [200, { users }];
    const { email } = JSON.parse(body) as { email?: string };
    if (method === 'PUT') {
      // A password reset updates the sign-in's row, as GoTrue's does.
      const id = path.split('/').at(-1);
      await owner().admin.execute('update auth.users set email = email where id = $1', [id]);
      return [200, { id }];
    }
    if (users.some((user) => user.email === email)) return [422, { msg: 'already registered' }];
    const user = { id: randomUUID(), email: email ?? '' };
    await owner().admin.execute('insert into auth.users (id, email) values ($1, $2)', [
      user.id,
      user.email,
    ]);
    users.push(user);
    return [200, { id: user.id }];
  };
  const respond = async (request: IncomingMessage, response: ServerResponse, body: string) => {
    let answered: [number, unknown];
    try {
      answered = await answer(request.method ?? 'GET', request.url ?? '', body);
    } catch (error) {
      answered = [500, { msg: String(error) }];
    }
    response.writeHead(answered[0], { 'content-type': 'application/json' });
    response.end(JSON.stringify(answered[1]));
  };
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => void respond(request, response, body));
  });
  await new Promise<void>((listening) => {
    server.listen(0, '127.0.0.1', listening);
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** A scratch checkout holding the seed steps' scripts, and the local signing key. */
export async function openWorld(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), 'local-seed-order-'));
  const seedSteps = documentedSteps()
    .map((step) => step.script)
    .filter((script) => script in RUN);
  const files = [
    ...seedSteps.map((script) => scriptFile(script)),
    'scripts/local-seed-roles.ts',
    'scripts/local/signing-key.mjs',
  ];
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(repo, file), join(root, file));
  }
  for (const link of ['scripts/ops', 'packages', 'node_modules'])
    symlinkSync(join(repo, link), join(root, link));
  mkdirSync(join(root, '.local'));
  const key = spawnSync(process.execPath, [join(root, 'scripts/local/signing-key.mjs')], {
    encoding: 'utf8',
  });
  writeFileSync(join(root, '.local/auth-signing-key.json'), key.stdout, { mode: 0o600 });
  const opened: Partial<World> = { root };
  const identity = await identityService(() => opened.db!);
  return Object.assign(opened, { identity: identity.server, identityUrl: identity.url }) as World;
}

export interface Ran {
  readonly script: string;
  readonly status: number | null;
  readonly out: string;
}

const ok = (script: string): Ran => ({ script, status: 0, out: '' });

const STAND_INS: Readonly<Record<string, (w: World) => Promise<Ran>>> = {
  async 'db:up'(w) {
    w.db ??= await createFreshDatabase({ part: 'seedorder' });
    return ok('db:up');
  },
  // The harness migrated it with the runner db:migrate calls (migrate.ts).
  'db:migrate': (w) =>
    Promise.resolve(
      w.db?.migration === undefined ? { ...ok('db:migrate'), status: 1 } : ok('db:migrate'),
    ),
  async 'auth:up'(w) {
    await w.db!.admin.execute('create schema if not exists auth');
    await w.db!.admin.execute(
      'create table if not exists auth.users (id uuid primary key, email text)',
    );
    return ok('auth:up');
  },
};

/** The steps that run as their own processes, from the scratch checkout. */
const RUN: Readonly<Record<string, true>> = {
  'auth:seed': true,
  'db:admit': true,
  'db:seed': true,
};

/**
 * One seed step as its own process. Asynchronous: the identity service it
 * calls answers from this process, which a synchronous spawn would block.
 */
async function run(w: World, step: Step): Promise<Ran> {
  const url = new URL(serverUrl!);
  url.pathname = `/${w.db!.name}`;
  const child = spawn(process.execPath, [join(w.root, scriptFile(step.script))], {
    timeout: 240_000,
    env: {
      PATH: process.env['PATH'] ?? '',
      DATABASE_ADMIN_URL: url.toString(),
      DATABASE_URL: w.db!.appUrl,
      OPS_SEED_DIR: join(w.root, '.local'),
      GOTRUE_URL: w.identityUrl,
      ...step.env,
    },
  });
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
  const [status] = (await once(child, 'close')) as [number | null];
  return { script: step.script, status, out };
}

/**
 * The documented sequence, stopping at the first step that fails as `&&`
 * does. `before` runs ahead of the named step, as a person or a restore might.
 */
export async function startAsDocumented(
  w: World,
  before: Readonly<Record<string, () => Promise<unknown>>> = {},
): Promise<Ran[]> {
  const ran: Ran[] = [];
  for (const step of documentedSteps()) {
    // In order: each step builds on the one before.
    // oxlint-disable-next-line no-await-in-loop
    await before[step.script]?.();
    const stand = STAND_INS[step.script];
    if (stand === undefined && RUN[step.script] !== true)
      throw new Error(`no runner for the documented step ${step.script}`);
    // oxlint-disable-next-line no-await-in-loop
    const result = await (stand === undefined ? run(w, step) : stand(w));
    ran.push(result);
    if (result.status !== 0) break;
  }
  return ran;
}

export const failed = (ran: readonly Ran[]): Ran | undefined =>
  ran.find((step) => step.status !== 0);

export const keys = async (w: World): Promise<string[]> =>
  (
    await w.db!.admin.execute<{ key: string }>('select key from public.businesses order by key')
  ).map((row) => row.key);

export const mark = async (w: World): Promise<string | null> =>
  (
    await w.db!.admin.execute<{ mark: string | null }>(
      `select shobj_description(oid, 'pg_database') as mark
         from pg_database where datname = current_database()`,
    )
  )[0]!.mark;

/** The world's scratch checkout, identity service and database, gone. */
export async function closeWorld(w: World): Promise<void> {
  await new Promise((done) => {
    w.identity.close(done);
  });
  rmSync(w.root, { recursive: true, force: true });
  await w.db?.drop();
}
