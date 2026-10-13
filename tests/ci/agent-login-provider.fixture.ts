// SPDX-License-Identifier: AGPL-3.0-only
//
// The sign-in provider's users for the agent login tool's make
// (agent-login-make.test.ts), served by agent-login.fixture.ts's stand-in: its
// admin users API under the service key, which answers an address already
// held with 422 as GoTrue does, and its password grant, which signs a bearer
// with the run's test key. And the tool as its command, a process of its own,
// and a run started while the agent's lock is held.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { signBearer } from '../support/sign-in.ts';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { waitingOnTheLock, type Answer, type Handler, type World } from './agent-login.fixture.ts';

export interface User {
  id: string;
  email: string;
  password: string;
  app_metadata: Record<string, unknown>;
}

/** The provider's users, what it was asked, and the next id it issues when one is set. */
export interface Users {
  readonly list: User[];
  nextId?: string | undefined;
  world?: World;
  readonly handle: Handler;
}

const shown = ({ password: _password, ...user }: User): Omit<User, 'password'> => user;

async function grant(users: Users, body: Record<string, unknown>): Promise<Answer> {
  const user = users.list.find((u) => u.email === body['email'] && u.password === body['password']);
  if (user === undefined) return [400, { error_description: 'Invalid login credentials' }];
  const claims = { sub: user.id, aud: 'authenticated', iss: users.world?.env['GOTRUE_URL'] };
  const exp = Math.floor(Date.now() / 1000) + 600;
  const token = await signBearer({
    ...claims,
    role: 'authenticated',
    exp,
    session_id: randomUUID(),
  });
  return [200, { access_token: token, expires_in: 600 }];
}

function admin(users: Users, method: string, route: string, body: Record<string, unknown>): Answer {
  const [path = '', query = ''] = route.split('?');
  if (method === 'POST' && path === '/admin/users') {
    if (users.list.some((u) => u.email === body['email'])) return [422, { code: 'email_exists' }];
    const id = users.nextId ?? randomUUID();
    const metadata = (body['app_metadata'] ?? {}) as Record<string, unknown>;
    const user = { id, email: String(body['email']), password: String(body['password']) };
    users.list.push({ ...user, app_metadata: metadata });
    return [200, shown({ ...user, app_metadata: metadata })];
  }
  if (method === 'GET' && path === '/admin/users') {
    const page = Number(new URLSearchParams(query).get('page') ?? '1');
    const listed = users.list.slice((page - 1) * 200, page * 200);
    return [200, { users: listed.map((user) => shown(user)) }];
  }
  const user = users.list.find((u) => u.id === path.split('/')[3]);
  if (user === undefined) return [404, { code: 'user_not_found' }];
  if (method === 'PUT') Object.assign(user, body);
  return [200, shown(user)];
}

/** A provider holding no user yet; `world` is set once the world that serves it is made. */
export function providerUsers(): Users {
  const users: Users = {
    list: [],
    handle: async ({ method, route, text }) => {
      const body = (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>;
      if (route.startsWith('/token')) return await grant(users, body);
      return admin(users, method, route, body);
    },
  };
  return users;
}

const PRELOADS = ['pooler-at-loopback.mjs', 'plaintext-at-loopback.mjs'].map(
  (name) => `--import=${new URL(`../support/${name}`, import.meta.url).pathname}`,
);
const COMMAND = new URL('../../scripts/ops/agent-login.mjs', import.meta.url).pathname;

/** The tool as its command, the password on its standard input: its status and all it printed. */
export async function runCommand(
  world: World,
  args: readonly string[],
  password: string,
): Promise<{ status: number; printed: string }> {
  const child = spawn(process.execPath, [...PRELOADS, COMMAND, ...args], { env: world.env });
  let printed = '';
  const keep = (chunk: Buffer): void => {
    printed += chunk.toString('utf8');
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.stdin.end(password);
  const status = await new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? -1));
  });
  return { status, printed };
}

/** Holds `agent`'s lock, starts a run, and once it waits there runs `during`, then lets it go. */
export async function holdingTheAgent<T>(
  world: World,
  agent: string,
  during: () => Promise<void>,
  start: () => Promise<T>,
): Promise<T> {
  const plain = (world.env['DATABASE_ADMIN_URL'] ?? '').replace(/[?].*$/u, '?sslmode=disable');
  const holder = connectAsAdmin(plain, { source: 'harness' });
  try {
    const { started } = await holder.transaction(async (execute) => {
      const key = `agent-login:${world.alpha}:${agent}`;
      await execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
      const run = start();
      // A run that ends without waiting answers for itself.
      await Promise.race([waitingOnTheLock(world), run]);
      await during();
      return { started: run };
    });
    return await started;
  } finally {
    await holder.close();
  }
}
