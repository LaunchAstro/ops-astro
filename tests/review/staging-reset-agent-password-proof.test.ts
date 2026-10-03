// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  onDatabase,
  run,
  serverUrl,
  settings,
  stagingResetHooks,
} from '../ci/s0-1-staging-reset.fixture.ts';

stagingResetHooks();

it.skipIf(serverUrl === undefined)(
  'an agent can sign in with the credential written by a repeated staging reset',
  async () => {
    const users = new Map<string, { id: string; email: string; password: string }>();
    const provider = createServer((request, response) => {
      let text = '';
      request.on('data', (chunk: Buffer) => { text += chunk.toString(); });
      request.on('end', async () => {
        const body = text === '' ? {} : JSON.parse(text);
        const path = (request.url ?? '').split('?')[0];
        const reply = (status: number, value: unknown) => {
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(value));
        };
        if (request.method === 'GET' && path === '/admin/users') {
          return reply(200, { users: [...users.values()].map(({ id, email }) => ({ id, email })) });
        }
        if (request.method === 'POST' && path === '/admin/users') {
          if (users.has(body.email)) return reply(422, { msg: 'already registered' });
          const user = { id: randomUUID(), email: body.email, password: body.password };
          await onDatabase((admin) => admin.execute(
            'insert into auth.users (id, email) values ($1, $2)', [user.id, user.email],
          ));
          users.set(user.email, user);
          return reply(200, { id: user.id, email: user.email });
        }
        if (request.method === 'PUT' && path?.startsWith('/admin/users/')) {
          const user = [...users.values()].find((entry) => entry.id === path.split('/').at(-1));
          if (user === undefined) return reply(404, {});
          user.password = body.password;
          return reply(200, { id: user.id });
        }
        if (request.method === 'POST' && path === '/token') {
          const user = users.get(body.email);
          return reply(user?.password === body.password ? 200 : 400, {});
        }
        return reply(404, {});
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (typeof address !== 'object' || address === null) throw new Error('no provider address');
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const first = settings({ GOTRUE_URL: url });
      expect((await run(first)).status, 'the first reset must complete').toBe(0);
      const previous = JSON.parse(readFileSync(join(first['OPS_SEED_DIR'] ?? '', 'synthetic-agents.json'), 'utf8'));
      const second = settings({ GOTRUE_URL: url });
      expect((await run(second)).status, 'the repeated reset reports success').toBe(0);
      const current = JSON.parse(readFileSync(join(second['OPS_SEED_DIR'] ?? '', 'synthetic-agents.json'), 'utf8'));
      const signIn = async (user: { email: string; password: string }) => (await fetch(`${url}/token?grant_type=password`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(user),
      })).status;
      expect(await signIn(previous[0]), 'positive control: the provider still accepts the previous credential').toBe(200);
      expect(current[0].password === previous[0].password, 'the new file contains a different credential').toBe(false);
      expect(await signIn(current[0]), 'the credential reported as confirmed in GoTrue must sign in').toBe(200);
    } finally {
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  },
  180_000,
);
