// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines, max-lines-per-function -- one review fixture and explicit concurrent schedules */
// Review proofs only. Real migrated Postgres, real CLI child processes, and an
// HTTP stand-in for the external provider. All credentials here are invented.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createFreshDatabase } from '../support/fresh-database.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { lockAccess } from '../../packages/core-records/src/authority/access.ts';

type Run = { code: number | null; stdout: string; stderr: string };
const uninitialised = (): void => {
  throw new Error('promise not initialised');
};

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
    holdCreation: (wait: () => Promise<void>) => void;
  }) => Promise<void>,
): Promise<void> {
  const db = await createFreshDatabase({ part: 'ow069' });
  const dir = mkdtempSync(join(tmpdir(), 'sol-ow069-'));
  const alpha = randomUUID();
  const users = new Map<string, string>();
  let beforeCreate: (() => Promise<void>) | undefined;
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
      if (beforeCreate) await beforeCreate();
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
      holdCreation: (wait) => {
        beforeCreate = wait;
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

function signal() {
  let resolve = uninitialised;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('removal during a pending make leaves no untracked provider login', async () => {
  await fixture(async ({ cli, users, holdCreation }) => {
    const entered = signal();
    const release = signal();
    holdCreation(async () => {
      entered.resolve();
      await release.promise;
    });
    const making = cli('make');
    try {
      await entered.promise;
      const removing = cli('remove');
      await Promise.race([removing, new Promise((r) => setTimeout(r, 500))]);
      release.resolve();
      await removing;
      const made = await making;
      expect(made.code, made.stderr).toBe(0);
      const cleanup = await cli('remove');
      expect(cleanup.code, cleanup.stderr).toBe(0);
      expect(users.size, 'the successful make lost its preclaimed recovery record to remove').toBe(
        0,
      );
    } finally {
      release.resolve();
      await making;
    }
  });
});

it('business to business removal preserves a login mapped in a business created while waiting', async () => {
  await fixture(async ({ cli, db, alpha, users, loginFile }) => {
    expect((await cli('make')).code).toBe(0);
    const record = JSON.parse(readFileSync(loginFile, 'utf8'));
    const blocker = connect(db.appUrl);
    const held = signal();
    const release = signal();
    const holding = blocker.withBusiness(alpha, async (tx) => {
      await lockAccess(tx);
      held.resolve();
      await release.promise;
    });
    let removing: Promise<Run> | undefined;
    try {
      await held.promise;
      removing = cli('remove');
      let waiting = false;
      for (let tries = 0; tries < 200 && !waiting; tries++) {
        const rows = await db.admin.execute<{ n: number }>(
          "select count(*)::int as n from pg_stat_activity where datname=$1 and wait_event_type='Lock' and query like '%pg_advisory_xact_lock%'",
          [db.name],
        );
        waiting = (rows[0]?.n ?? 0) > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 25));
      }
      expect(waiting, 'remove enumerated businesses and now waits for the access lock').toBe(true);
      const business = randomUUID(),
        person = randomUUID(),
        actor = randomUUID(),
        login = randomUUID();
      await db.admin.execute(
        'insert into public.businesses (business_id,id,key,name) values ($1,$1,$2,$2)',
        [business, 'charlie'],
      );
      await db.admin.execute(
        'insert into public.people (business_id,id,display_name) values ($1,$2,$3)',
        [business, person, 'Charlie private person'],
      );
      await db.admin.execute(
        "insert into public.actors (business_id,id,kind,person_id) values ($1,$2,'person',$3)",
        [business, actor, person],
      );
      await db.admin.execute(
        "insert into public.logins (business_id,id,provider,subject) values ($1,$2,'supabase',$3)",
        [business, login, record.userId],
      );
      await db.admin.execute(
        'insert into public.person_logins (business_id,id,login_id,person_id,active,linked_by_actor_id) values ($1,$2,$3,$4,true,$5)',
        [business, randomUUID(), login, person, actor],
      );
      release.resolve();
      await holding;
      const removed = await removing;
      expect(
        users.has(record.userId),
        'another business still has an active mapping to this provider login',
      ).toBe(true);
      expect(removed.code).toBe(1);
    } finally {
      release.resolve();
      await holding;
      await removing;
      await blocker.close();
    }
  });
});
