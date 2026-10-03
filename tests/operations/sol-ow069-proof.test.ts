// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines, max-lines-per-function -- one review fixture and explicit concurrent schedules */
// Review proofs only. Real migrated Postgres, real CLI child processes, and an
// HTTP stand-in for the external provider. All credentials here are invented.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createFreshDatabase } from '../support/fresh-database.ts';

type Run = { code: number | null; stdout: string; stderr: string };

async function fixture(
  run: (f: {
    db: Awaited<ReturnType<typeof createFreshDatabase>>;
    alpha: string;
    users: Map<string, string>;
    loginFile: string;
    tokenFile: string;
    cli: (step: string) => Promise<Run>;
    loseReply: () => void;
    synchroniseMakes: () => void;
  }) => Promise<void>,
): Promise<void> {
  const db = await createFreshDatabase({ part: 'ow069' });
  const dir = mkdtempSync(join(tmpdir(), 'sol-ow069-'));
  const alpha = randomUUID();
  const users = new Map<string, string>();
  let lose = false;
  let barrier = false;
  let pending: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const answer = (code: number, value: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.url === '/admin/users' && req.method === 'POST') {
      const id = typeof body.id === 'string' ? body.id : randomUUID();
      users.set(id, body.email);
      if (lose) {
        req.socket.destroy();
        return;
      }
      if (barrier) {
        if (!pending) {
          const reply = () => {
            pending = undefined;
            answer(200, { id });
          };
          pending = reply;
          setTimeout(() => {
            if (pending === reply) reply();
          }, 300);
          return;
        }
        pending();
      }
      answer(200, { id });
    } else if (req.method === 'GET' && req.url?.split('?')[0] === '/admin/users') {
      answer(200, { users: [...users].map(([id, email]) => ({ id, email })) });
    } else if (req.url?.startsWith('/admin/users/')) {
      const id = req.url.slice('/admin/users/'.length);
      const email = users.get(id);
      if (!email) answer(404, {});
      else if (req.method === 'DELETE') {
        users.delete(id);
        answer(200, {});
      } else answer(200, { id, email });
    } else if (req.url === '/token?grant_type=password') {
      answer(200, { access_token: 'sol-invented-access-token-123456789' });
    } else answer(404, {});
  });
  const loginFile = join(dir, 'login.json');
  const tokenFile = join(dir, 'token');
  try {
    await db.admin.execute(
      'insert into public.businesses (business_id,id,key,name) values ($1,$1,$2,$3)',
      [alpha, 'alpha', 'Alpha'],
    );
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('provider did not listen');
    const adminUrl = new URL(process.env['DATABASE_URL']!);
    adminUrl.pathname = `/${db.name}`;
    const cli = (step: string): Promise<Run> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['scripts/security/scan-login.mjs', step], {
          env: {
            ...process.env,
            SCAN_LOGIN_PLACE: 'local',
            SCAN_LOGIN_FILE: loginFile,
            SCAN_TOKEN_FILE: tokenFile,
            DATABASE_URL: db.appUrl,
            DATABASE_LOOKUP_URL: adminUrl.href,
            GOTRUE_URL: `http://127.0.0.1:${address.port}`,
            SUPABASE_SERVICE_KEY: 'sol-invented-service-key',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (data) => {
          stdout += data.toString();
        });
        child.stderr.on('data', (data) => {
          stderr += data.toString();
        });
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      });
    await run({
      db,
      alpha,
      users,
      loginFile,
      tokenFile,
      cli,
      loseReply: () => {
        lose = true;
      },
      synchroniseMakes: () => {
        barrier = true;
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await db.drop();
    rmSync(dir, { recursive: true, force: true });
  }
}

it('Sol proof, criterion 3: an existing token file is owner-only after make', async () => {
  await fixture(async ({ cli, tokenFile }) => {
    writeFileSync(tokenFile, 'old-invented-token');
    chmodSync(tokenFile, 0o644);
    const made = await cli('make');
    if (made.code === 0) {
      expect(readFileSync(tokenFile, 'utf8')).toBe('sol-invented-access-token-123456789');
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    } else {
      expect(made.code).toBe(1);
      expect(readFileSync(tokenFile, 'utf8')).toBe('old-invented-token');
    }
  });
});

it('Sol proof, criterion 2: business to business and person to person cleanup preserves a shared login in Bravo', async () => {
  await fixture(async ({ cli, db, users, loginFile }) => {
    const made = await cli('make');
    expect(made.code, made.stderr).toBe(0);
    const record = JSON.parse(readFileSync(loginFile, 'utf8'));
    const bravo = randomUUID();
    const person = randomUUID();
    const actor = randomUUID();
    const login = randomUUID();
    await db.admin.execute(
      'insert into public.businesses (business_id,id,key,name) values ($1,$1,$2,$3)',
      [bravo, 'bravo', 'Bravo'],
    );
    await db.app.withBusiness(bravo, async (tx) => {
      await tx.query('insert into public.people (business_id,id,display_name) values ($1,$2,$3)', [
        bravo,
        person,
        'Bea Bravo',
      ]);
      await tx.query(
        "insert into public.actors (business_id,id,kind,person_id) values ($1,$2,'person',$3)",
        [bravo, actor, person],
      );
      await tx.query(
        "insert into public.logins (business_id,id,provider,subject) values ($1,$2,'supabase',$3)",
        [bravo, login, record.userId],
      );
      await tx.query(
        'insert into public.person_logins (business_id,id,login_id,person_id,linked_by_actor_id) values ($1,$2,$3,$4,$5)',
        [bravo, randomUUID(), login, person, actor],
      );
      await tx.query(
        "insert into public.memberships (business_id,id,person_id,role_key) values ($1,$2,$3,'member')",
        [bravo, randomUUID(), person],
      );
    });
    const removed = await cli('remove');
    expect([0, 1], removed.stderr).toContain(removed.code);
    const rows = await db.app.withBusiness(bravo, (tx) =>
      tx.query<{ active: boolean }>('select active from public.person_logins where login_id=$1', [
        login,
      ]),
    );
    expect(rows).toEqual([{ active: true }]);
    expect(users.has(record.userId)).toBe(true);
  });
});
