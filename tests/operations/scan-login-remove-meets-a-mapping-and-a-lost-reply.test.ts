// SPDX-License-Identifier: AGPL-3.0-only
//
// `scan-login remove` checks no other business maps the sign-in, ends the
// scan person under the subject lock, then deletes the account. Real migrated
// Postgres, the real CLI as a child process (a connection of its own), and an
// HTTP stand-in for GoTrue's admin API. Every credential here is invented.
//
// An agent mapping in another business left inactive is made live again on the
// test's own backend while the cleanup is at the provider delete: the end is
// the mapping refused with the account deleted, or live with the account kept.
// A delete whose reply is lost, whether the account went or not, is run again:
// the account goes once, the scan person stays ended, the record is removed.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { createFreshDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';

type Database = Awaited<ReturnType<typeof createFreshDatabase>>;
type Run = { readonly code: number | null; readonly stderr: string };

/** What the stand-in does with the next DELETE: answer, or lose the reply after or before deleting. */
type Deleting = 'answer' | 'lost after deleting' | 'lost before deleting';

interface Stand {
  readonly users: Map<string, string>;
  onDelete?: () => void;
  deleting: Deleting;
  deletes: number;
}

/** GoTrue's admin API, as far as scan-login uses it. */
function provider(stand: Stand): Server {
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
      const made = typeof body.id === 'string' ? body.id : randomUUID();
      stand.users.set(made, body.email);
      answer(200, { id: made });
    } else if (req.url === '/token?grant_type=password') {
      answer(200, { access_token: 'invented-access-token-123456789' });
    } else if (!stand.users.has(id)) {
      answer(404, {});
    } else if (req.method === 'DELETE') {
      stand.onDelete?.();
      // Long enough for a mapping begun at the delete to reach the database.
      await sleep(300);
      const how = stand.deleting;
      stand.deleting = 'answer';
      if (how !== 'lost before deleting') {
        stand.users.delete(id);
        stand.deletes += 1;
      }
      if (how === 'answer') answer(200, {});
      else res.destroy();
    } else answer(200, { id, email: stand.users.get(id) });
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

/** A fresh database with Alpha, the stand-in listening and a scan login made, for `run`. */
async function withScanLogin(
  part: string,
  run: (world: {
    db: Database;
    dir: string;
    port: number;
    stand: Stand;
    userId: string;
  }) => Promise<void>,
): Promise<void> {
  const db = await createFreshDatabase({ part });
  const dir = mkdtempSync(join(tmpdir(), 'scan-login-retry-'));
  const stand: Stand = { users: new Map(), deleting: 'answer', deletes: 0 };
  const server = provider(stand);
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
    await run({ db, dir, port, stand, userId });
  } finally {
    delete stand.onDelete;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await db.drop();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Bravo, with an agent whose mapping to the sign-in exists and is not live. */
async function bravoWithAnInactiveAgentLogin(db: Database, subject: string) {
  const [business, agent, login, mapping] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  await db.admin.execute(
    'insert into public.businesses (business_id, id, key, name) values ($1, $1, $2, $3)',
    [business, 'bravo', 'Bravo'],
  );
  await db.app.withBusiness(business, async (tx) => {
    await tx.query(
      "insert into public.actors (business_id, id, kind, active) values ($1, $2, 'agent', true)",
      [business, agent],
    );
    await tx.query(
      "insert into public.logins (business_id, id, provider, subject) values ($1, $2, 'supabase', $3)",
      [business, login, subject],
    );
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $4)`,
      [business, mapping, login, agent],
    );
  });
  await db.admin.execute(
    'update public.actor_logins set active = false, deactivated_at = now() where id = $1',
    [mapping],
  );
  const reactivate = () =>
    db.app.withBusiness(business, (tx) =>
      tx.query(
        `update public.actor_logins set active = true, deactivated_at = null
          where business_id = $1 and id = $2`,
        [business, mapping],
      ),
    );
  const live = async () =>
    (
      await db.admin.execute<{ active: boolean }>(
        'select active from public.actor_logins where id = $1',
        [mapping],
      )
    )[0]?.active === true;
  return { reactivate, live };
}

/** Whether the scan sign-in still maps a live person in the scan business. */
const scanPersonLive = async (db: Database, userId: string): Promise<boolean> =>
  (
    await db.admin.execute<{ n: number }>(
      `select count(*)::int as n from public.logins l
         join public.person_logins pl on pl.login_id = l.id
        where l.provider = 'supabase' and l.subject = $1 and pl.active`,
      [userId],
    )
  )[0]?.n !== 0;

const noDatabase = databaseUrlFromEnvironment() === undefined;

it.skipIf(noDatabase)(
  'an agent mapping made live again in another business during scan-login cleanup is refused with the account deleted, or live with the account kept',
  async () => {
    await withScanLogin('scanreactivate', async ({ db, dir, port, stand, userId }) => {
      const bravo = await bravoWithAnInactiveAgentLogin(db, userId);
      let mapping: Promise<boolean> | undefined;
      stand.onDelete = () => {
        mapping ??= bravo.reactivate().then(
          () => false,
          () => true,
        );
      };
      await cli(db, dir, port, 'remove');
      expect(mapping, 'the cleanup reached the provider delete').toBeDefined();
      const state = {
        refused: await mapping,
        live: await bravo.live(),
        kept: stand.users.has(userId),
      };
      expect([
        { refused: true, live: false, kept: false },
        { refused: false, live: true, kept: true },
      ]).toContainEqual(state);
    });
  },
);

it.skipIf(noDatabase).each<Deleting>(['lost after deleting', 'lost before deleting'])(
  'a scan-login remove whose provider delete reply is %s, run again, deletes the account once and removes the record',
  async (deleting) => {
    await withScanLogin(
      `scanlost${deleting.split(' ')[1]}`,
      async ({ db, dir, port, stand, userId }) => {
        stand.deleting = deleting;
        const first = await cli(db, dir, port, 'remove');
        expect(first.code, first.stderr).toBe(1);
        expect(stand.users.has(userId)).toBe(deleting === 'lost before deleting');
        expect(existsSync(join(dir, 'login.json'))).toBe(true);
        const again = await cli(db, dir, port, 'remove');
        expect(again.code, again.stderr).toBe(0);
        expect({
          kept: stand.users.has(userId),
          deletes: stand.deletes,
          scanPersonLive: await scanPersonLive(db, userId),
          record: existsSync(join(dir, 'login.json')),
        }).toEqual({ kept: false, deletes: 1, scanPersonLive: false, record: false });
      },
    );
  },
);
