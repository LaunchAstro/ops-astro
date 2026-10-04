// SPDX-License-Identifier: AGPL-3.0-only
//
// A repeated staging reset writes a new agent credential, and it must sign in.
// Taken from Sol's proof (OW-067) with its positive control moved to after the
// first reset: after the second, one agent user can hold only the new
// password, so the replaced one is refused.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  onDatabase,
  run,
  serverUrl,
  settings,
  stagingResetHooks,
} from './s0-1-staging-reset.fixture.ts';

stagingResetHooks();

interface User {
  readonly id: string;
  readonly email: string;
  password: string;
}

/** The provider's admin API and password sign-in, one password per user, on loopback. */
function provider(users: Map<string, User>): Server {
  return createServer((request, response) => {
    let text = '';
    request.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    request.on('end', async () => {
      const body = (text === '' ? {} : JSON.parse(text)) as { email: string; password: string };
      const path = (request.url ?? '').split('?')[0] ?? '';
      const reply = (status: number, value: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      const at = `${request.method ?? ''} ${path.startsWith('/admin/users/') ? '/admin/users/' : path}`;
      if (at === 'GET /admin/users')
        return reply(200, { users: [...users.values()].map(({ id, email }) => ({ id, email })) });
      if (at === 'POST /admin/users') {
        if (users.has(body.email)) return reply(422, { msg: 'already registered' });
        const user = { id: randomUUID(), email: body.email, password: body.password };
        await onDatabase((admin) =>
          admin.execute('insert into auth.users (id, email) values ($1, $2)', [
            user.id,
            user.email,
          ]),
        );
        users.set(user.email, user);
        return reply(200, { id: user.id, email: user.email });
      }
      if (at === 'PUT /admin/users/') {
        const user = [...users.values()].find((entry) => entry.id === path.split('/').at(-1));
        if (user === undefined) return reply(404, {});
        user.password = body.password;
        return reply(200, { id: user.id });
      }
      if (at === 'POST /token')
        return reply(users.get(body.email)?.password === body.password ? 200 : 400, {});
      return reply(404, {});
    });
  });
}

const agents = (env: Record<string, string>): { email: string; password: string }[] =>
  JSON.parse(readFileSync(join(env['OPS_SEED_DIR'] ?? '', 'synthetic-agents.json'), 'utf8')) as {
    email: string;
    password: string;
  }[];

it.skipIf(serverUrl === undefined)(
  'an agent can sign in with the credential written by a repeated staging reset',
  async () => {
    const server = provider(new Map());
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (typeof address !== 'object' || address === null) throw new Error('no provider address');
    const url = `http://127.0.0.1:${String(address.port)}`;
    const signIn = async (user: { email: string; password: string } | undefined) =>
      (
        await fetch(`${url}/token?grant_type=password`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(user),
        })
      ).status;
    try {
      const first = settings({ GOTRUE_URL: url });
      expect((await run(first)).status, 'the first reset must complete').toBe(0);
      const [previous] = agents(first);
      expect(await signIn(previous), "positive control: the first reset's credential").toBe(200);
      const second = settings({ GOTRUE_URL: url });
      expect((await run(second)).status, 'the repeated reset reports success').toBe(0);
      const [current] = agents(second);
      expect(current?.password, 'the new file holds a different credential').not.toBe(
        previous?.password,
      );
      expect(await signIn(current), 'the credential the reset wrote signs in').toBe(200);
      expect(await signIn(previous), 'the replaced credential no longer signs in').toBe(400);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  },
  180_000,
);
