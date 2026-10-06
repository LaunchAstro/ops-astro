// SPDX-License-Identifier: AGPL-3.0-only
// OW-069.1: another business maps the scan sign-in to a person while
// `scan-login remove` is cleaning it up. Real migrated Postgres, the real CLI
// as a child process, and an HTTP stand-in for GoTrue's admin API. Every
// credential here is invented.
//
// The mapping is started on its own backend once the cleanup's checks are done
// (the stand-in's DELETE handler is the first point after them), and is not
// awaited there: a cleanup that holds a lock the mapping needs would otherwise
// wait on its own reply. It is settled as it ends, so a refusal is an outcome
// and not an unhandled rejection, and awaited after `remove` exits. Whatever the
// order, the end state is one of two: the mapping refused and the account
// deleted, or the mapping live and the account kept. A live mapping to a
// deleted account is the failure.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { createFreshDatabase } from '../support/fresh-database.ts';

type Database = Awaited<ReturnType<typeof createFreshDatabase>>;
type Run = { readonly code: number | null; readonly stderr: string };

/** GoTrue's admin API, as far as scan-login uses it. `onDelete` runs as a DELETE arrives. */
function provider(users: Map<string, string>, hooks: { onDelete?: () => void }): Server {
  return createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const answer = (code: number, value: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const id = req.url?.startsWith('/admin/users/') ? req.url.slice('/admin/users/'.length) : '';
    if (req.url === '/admin/users' && req.method === 'POST') {
      const made = randomUUID();
      users.set(made, body.email);
      answer(200, { id: made });
    } else if (req.url === '/token?grant_type=password') {
      answer(200, { access_token: 'invented-access-token-123456789' });
    } else if (!users.has(id)) {
      answer(404, {});
    } else if (req.method === 'DELETE') {
      hooks.onDelete?.();
      // Long enough for the mapping to reach the database; never waits on it.
      await sleep(300);
      users.delete(id);
      answer(200, {});
    } else answer(200, { id, email: users.get(id) });
  });
}

function cli(db: Database, dir: string, port: number, step: string): Promise<Run> {
  const lookupUrl = new URL(process.env['DATABASE_URL'] ?? '');
  lookupUrl.pathname = `/${db.name}`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/security/scan-login.mjs', step], {
      env: {
        ...process.env,
        SCAN_LOGIN_PLACE: 'local',
        SCAN_LOGIN_FILE: join(dir, 'login.json'),
        SCAN_TOKEN_FILE: join(dir, 'token'),
        DATABASE_URL: db.appUrl,
        DATABASE_LOOKUP_URL: lookupUrl.href,
        GOTRUE_URL: `http://127.0.0.1:${String(port)}`,
        SUPABASE_SERVICE_KEY: 'invented-service-key',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

/** Bravo, with a login for `subject` and a person, the two not yet mapped. */
async function bravoWithLogin(db: Database, subject: string) {
  const [business, person, actor, login] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await db.admin.execute(
    'insert into public.businesses (business_id, id, key, name) values ($1, $1, $2, $3)',
    [business, 'bravo', 'Bravo'],
  );
  await db.app.withBusiness(business, async (tx) => {
    await tx.query(
      'insert into public.people (business_id, id, display_name) values ($1, $2, $3)',
      [business, person, 'Bea Bravo'],
    );
    await tx.query(
      "insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'person', $3)",
      [business, actor, person],
    );
    await tx.query(
      "insert into public.logins (business_id, id, provider, subject) values ($1, $2, 'supabase', $3)",
      [business, login, subject],
    );
  });
  const map = () =>
    db.app.withBusiness(business, (tx) =>
      tx.query(
        `insert into public.person_logins (business_id, id, login_id, person_id, linked_by_actor_id)
         values ($1, $2, $3, $4, $5)`,
        [business, randomUUID(), login, person, actor],
      ),
    );
  const live = async () =>
    (
      await db.app.withBusiness(business, (tx) =>
        tx.query<{ active: boolean }>(
          'select active from public.person_logins where login_id = $1',
          [login],
        ),
      )
    ).some((row) => row.active);
  return {
    map,
    live,
    remap: (next: string) => db.app.withBusiness(business, (tx) =>
      tx.query('update public.logins set subject = $1 where id = $2', [next, login])),
    subject: async () => (await db.app.withBusiness(business, (tx) =>
      tx.query<{ subject: string }>('select subject from public.logins where id = $1', [login])))[0]?.subject,
  };
}

it('business to business and person to person cleanup preserves an active login whose subject changes', async () => {
  const db = await createFreshDatabase({ part: 'scanrace' });
  const dir = mkdtempSync(join(tmpdir(), 'scan-login-race-'));
  const users = new Map<string, string>();
  const hooks: { onDelete?: () => void } = {};
  const server = provider(users, hooks);
  try {
    const alpha = randomUUID();
    await db.admin.execute(
      'insert into public.businesses (business_id, id, key, name) values ($1, $1, $2, $3)',
      [alpha, 'alpha', 'Alpha'],
    );
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    const made = await cli(db, dir, port, 'make');
    expect(made.code, made.stderr).toBe(0);
    const { userId } = JSON.parse(readFileSync(join(dir, 'login.json'), 'utf8')) as {
      userId: string;
    };
    const previousSubject = randomUUID();
    const bravo = await bravoWithLogin(db, previousSubject);
    await bravo.map();
    const remap = () => bravo.remap(userId);

    let mapping: Promise<boolean> | undefined;
    hooks.onDelete = () => {
      mapping ??= remap().then(
        () => false,
        () => true,
      );
    };
    await cli(db, dir, port, 'remove');
    expect(mapping, 'the cleanup reached the provider delete').toBeDefined();
    const state = {
      refused: await mapping,
      live: await bravo.live(),
      kept: users.has(userId),
    };
    expect(await bravo.subject()).toBe(state.refused ? previousSubject : userId);
    expect([
      { refused: true, live: true, kept: false },
      { refused: false, live: true, kept: true },
    ]).toContainEqual(state);
  } finally {
    delete hooks.onDelete;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await db.drop();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('business to business and person to person cleanup preserves a mapping committed in a new business before its lock', async () => {
  const db = await createFreshDatabase({ part: 'scan_new_business' });
  const dir = mkdtempSync(join(tmpdir(), 'scan-login-new-business-'));
  const users = new Map<string, string>();
  const server = provider(users, {});
  let removal: Promise<Run> | undefined;
  try {
    const alpha = randomUUID();
    await db.admin.execute('insert into public.businesses (business_id, id, key, name) values ($1, $1, $2, $3)', [alpha, 'alpha', 'Alpha']);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const made = await cli(db, dir, port, 'make');
    expect(made.code, made.stderr).toBe(0);
    const { userId } = JSON.parse(readFileSync(join(dir, 'login.json'), 'utf8')) as { userId: string };
    const [bravo, person, actor, login] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.app.withBusiness(bravo, async (tx) => {
      // Hold the same subject lock before cleanup. Its business-list snapshot
      // has been taken once it reaches this lock and waits on our backend.
      await tx.query("select pg_advisory_xact_lock(hashtextextended('supabase:' || $1, 0))", [userId]);
      removal = cli(db, dir, port, 'remove');
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
        const [row] = await db.admin.execute<{ waiting: boolean }>(
          "select exists (select from pg_stat_activity where datname = $1 and wait_event_type = 'Lock' and query like '%pg_advisory_xact_lock(hashtextextended%') as waiting", [db.name]);
        waiting = row?.waiting === true;
        if (!waiting) await sleep(20);
      }
      expect(waiting, 'cleanup read its business list and is waiting for the subject lock').toBe(true);
      await tx.query('insert into public.businesses (business_id, id, key, name) values ($1, $1, $2, $3)', [bravo, 'bravo', 'Bravo']);
      await tx.query('insert into public.people (business_id, id, display_name) values ($1, $2, $3)', [bravo, person, 'Bea Bravo']);
      await tx.query("insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'person', $3)", [bravo, actor, person]);
      await tx.query("insert into public.logins (business_id, id, provider, subject) values ($1, $2, 'supabase', $3)", [bravo, login, userId]);
      await tx.query('insert into public.person_logins (business_id, id, login_id, person_id, linked_by_actor_id) values ($1, $2, $3, $4, $5)', [bravo, randomUUID(), login, person, actor]);
      // The trigger legitimately admits this mapping: this transaction owns
      // the exclusive subject lock and commits before cleanup obtains it.
    });
    const removed = await removal;
    expect([0, 1], removed?.stderr).toContain(removed?.code);
    const mapped = await db.app.withBusiness(bravo, (tx) => tx.query('select from public.person_logins where login_id = $1 and active', [login]));
    expect(mapped, 'the Bravo mapping committed before cleanup acquired its lock').toHaveLength(1);
    expect(users.has(userId), 'cleanup must refresh its business list after waiting for the mapping transaction').toBe(true);
  } finally {
    await removal;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.drop();
    rmSync(dir, { recursive: true, force: true });
  }
});
