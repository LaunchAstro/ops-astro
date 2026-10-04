// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- explicit external-provider interruption schedule */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createFreshDatabase } from '../support/fresh-database.ts';

const uninitialised = (): void => {
  throw new Error('signal not initialised');
};

function signal() {
  let resolve = uninitialised;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('interrupted make cannot lose a provider creation still in flight', async () => {
  const db = await createFreshDatabase({ part: 'd2fix2' });
  const directory = mkdtempSync(join(tmpdir(), 'sol-d2-fix2-login-'));
  const entered = signal();
  const release = signal();
  const created = signal();
  const users = new Map<string, string>();
  const server = createServer(async (req, res) => {
    const answer = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/admin/users' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      entered.resolve();
      await release.promise;
      // A client's death or timeout does not cancel the provider's admitted work.
      users.set(body.id, body.email);
      created.resolve();
      answer(200, { id: body.id });
    } else if (req.url?.startsWith('/admin/users/')) {
      const id = req.url.slice('/admin/users/'.length);
      const email = users.get(id);
      if (email === undefined) answer(404, {});
      else if (req.method === 'DELETE') {
        users.delete(id);
        answer(200, {});
      } else answer(200, { id, email });
    } else answer(404, {});
  });
  const children: ReturnType<typeof spawn>[] = [];
  try {
    const alpha = randomUUID();
    await db.admin.execute(
      'insert into public.businesses (business_id,id,key,name) values ($1,$1,$2,$2)',
      [alpha, 'alpha'],
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('provider did not listen');
    const lookup = new URL(process.env['DATABASE_URL'] ?? '');
    lookup.pathname = `/${db.name}`;
    const login = join(directory, 'login.json');
    const run = (step: string) => {
      const child = spawn(process.execPath, ['scripts/security/scan-login.mjs', step], {
        env: {
          ...process.env,
          SCAN_LOGIN_PLACE: 'local',
          SCAN_LOGIN_FILE: login,
          SCAN_TOKEN_FILE: join(directory, 'token'),
          DATABASE_URL: db.appUrl,
          DATABASE_LOOKUP_URL: lookup.href,
          GOTRUE_URL: `http://127.0.0.1:${address.port}`,
          SUPABASE_SERVICE_KEY: 'sol-invented-service-key',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      children.push(child);
      let error = '';
      child.stderr.on('data', (chunk) => {
        error += String(chunk);
      });
      const done = once(child, 'close').then(([code]) => ({ code, error }));
      return { child, done };
    };
    const make = run('make');
    await entered.promise;
    expect(existsSync(login), 'creation has its recovery file before the provider works').toBe(
      true,
    );
    make.child.kill('SIGKILL');
    await make.done;
    const removing = run('remove');
    // A safe cleanup may wait for creation or refuse without consuming its record.
    await Promise.race([
      removing.done,
      new Promise<void>((done) => {
        setTimeout(done, 500);
      }),
    ]);
    release.resolve();
    await created.promise;
    await removing.done;
    const retry = await run('remove').done;
    expect(retry.code, retry.error).toBe(0);
    expect(
      users.size,
      'provider completed creation after cleanup discarded its recovery file',
    ).toBe(0);
  } finally {
    release.resolve();
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await db.drop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
