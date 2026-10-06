// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-14-10a, each mandate command up to commit (PRV-oa-1053-R1.1, R1.2), over
// HTTP against a real database (`mandates-world.ts`). A command's last wait is
// its business's audit chain. A grant that runs out while a command waits
// there, its rows already written, refuses it: each of the four, nothing
// kept. A sign-out through bravo, sent once the command's last read of its
// session (after its audit event) has found it live, waits for it to commit.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signOutSession } from '../../packages/core-commands/src/index.ts';
import type { Database, TransactionQuery } from '../../packages/core-records/src/index.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { authorised, ISSUER, post, type Answer } from '../api/fixture.ts';
import { provider, signOutWaits } from '../automations/session-stop.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold } from '../support/lock-waits.ts';
import { signBearer } from '../support/sign-in.ts';
import {
  AUD,
  buildMandatesWorld,
  detail,
  inDays,
  path,
  type MandatesWorld,
} from './mandates-world.ts';

const serverUrl = databaseUrlFromEnvironment();
const WHOLE = { kind: 'business', id: null } as const;

/** A backend parked on an advisory key, and whether it has written a mandate row. */
const PARKED = `select a.query, exists (
    select 1 from pg_locks l where l.pid = a.pid and l.granted and l.mode = 'RowExclusiveLock'
       and l.relation = 'public.standing_mandates'::regclass) as wrote
  from pg_stat_activity a
 where a.datname = current_database() and a.pid <> pg_backend_pid()
   and a.wait_event_type = 'Lock' and a.wait_event = 'advisory'`;

/** One transaction's statements, stopped once at the first live session read after its audit event. */
function stoppedAfterAudit(tx: TransactionQuery, stop: { armed?: () => Promise<void> }) {
  let audited = false;
  const wrapped: TransactionQuery = {
    businessId: tx.businessId,
    async query<Row>(text: string, parameters?: readonly unknown[]) {
      const rows = await tx.query<Row>(text, parameters);
      if (text.includes('insert into audit_events')) audited = true;
      const live = (rows[0] as { readonly ended?: unknown } | undefined)?.ended === false;
      if (audited && live && text.includes('ended_provider_sessions') && stop.armed) {
        const wait = stop.armed;
        delete stop.armed;
        await wait();
      }
      return rows;
    },
    async savepoint(work) {
      return await tx.savepoint(async (inner) => {
        await work(stoppedAfterAudit(inner, stop));
      });
    },
  };
  return wrapped;
}

/** A fresh second factor on a provider session of its own. */
async function signedIn(who: Member) {
  const sessionId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const bearer = await signBearer({
    sub: who.presented.subject,
    aud: 'authenticated',
    iss: ISSUER,
    role: 'authenticated',
    exp: now + 600,
    aal: 'aal2',
    amr: [
      { method: 'password', timestamp: now },
      { method: 'totp', timestamp: now },
    ],
    session_id: sessionId,
  });
  return { presented: { ...who.presented, sessionId }, bearer };
}

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('MP-14-10a mandate commands up to commit', () => {
  let w: MandatesWorld;
  let expirer: Member;
  let signer: Member;
  const stop: { armed?: () => Promise<void> } = {};
  let pool: Database;
  let api: MandatesWorld['controls']['api'];

  const send = async (bearer: string, name: string, body: Record<string, unknown>) =>
    await post(
      api,
      path('alpha', name),
      { operationId: randomUUID(), ...body },
      authorised(bearer),
    );

  beforeAll(async () => {
    w = await buildMandatesWorld('mp1410ac');
    const { db } = w.controls.fixture;
    expirer = await enrol(db.app, w.alpha, 'expirer');
    signer = await enrol(db.app, w.alpha, 'signer');
    await db.app.withBusiness(w.alpha, async (tx) => {
      await grantTo(tx, signer, 'manage', WHOLE, false, 'mandate');
    });
    // The signer's login reaches bravo too, so a sign-out there ends its session here (0061).
    await db.app.withBusiness(w.bravo, async (tx) => {
      const personId = await insertPerson(tx, 'signer-bravo');
      const actorId = await insertActor(tx, personId);
      await insertMembership(tx, personId);
      await insertMapping(tx, await insertLogin(tx, signer.presented.subject), personId, actorId);
    });
    pool = connect(db.appUrl, { source: 'runtime', max: 2 });
    const stopping: Database = {
      log: pool.log,
      close: async () => await pool.close(),
      withBusiness: async (businessId, run) =>
        await pool.withBusiness(businessId, async (tx) => await run(stoppedAfterAudit(tx, stop))),
    };
    api = w.controls.fixture.compose(undefined, undefined, stopping);
  }, 120_000);

  afterAll(async () => {
    await pool?.close();
    await w?.drop();
  });

  /** The expirer's one business-wide `mandate:manage`, ending three seconds from now. */
  const expiringGrant = async (): Promise<string> => {
    const { db } = w.controls.fixture;
    const grantId = await db.app.withBusiness(
      w.alpha,
      async (tx) => await grantTo(tx, expirer, 'manage', WHOLE, false, 'mandate'),
    );
    await db.admin.execute(
      `update public.grants set expires_at = clock_timestamp() + interval '3 seconds' where id = $1`,
      [grantId],
    );
    return grantId;
  };

  /** Polls until a command is parked on the audit chain; what it waits in and whether it wrote. */
  const parked = async (): Promise<{ readonly query: string; readonly wrote: boolean }> => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- polls, one look at a time
      const [row] = await w.controls.fixture.db.admin.execute<{ query: string; wrote: boolean }>(
        PARKED,
      );
      if (row !== undefined) return row;
      // eslint-disable-next-line no-await-in-loop -- as above
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    throw new Error('no command reached the audit chain');
  };

  const clock = async (grantId: string): Promise<{ live: boolean }> => {
    const [row] = await w.controls.fixture.db.admin.execute<{ live: boolean }>(
      'select clock_timestamp() < expires_at as live from public.grants where id = $1',
      [grantId],
    );
    return { live: row?.live === true };
  };

  /** One command sent while alpha's audit chain is held, let go once its only grant has run out. */
  const expiredWhileChained = async (name: string, body: Record<string, unknown>) => {
    const grantId = await expiringGrant();
    const { bearer } = await signedIn(expirer);
    const chained = await hold(w.controls.fixture.db.appUrl, w.alpha, async (tx) => {
      await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        w.alpha.toLowerCase(),
      ]);
    });
    const answer = send(bearer, name, body);
    const at = await parked();
    // Seen waiting with its rows written while its grant still held: past every earlier check.
    const seen = { wrote: at.wrote, ...(await clock(grantId)) };
    for (let attempt = 0; (await clock(grantId)).live; attempt += 1) {
      if (attempt > 100) throw new Error('the grant never ran out');
      // eslint-disable-next-line no-await-in-loop -- until the database clock passes it
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    await chained.letGo();
    const reply: Answer = await answer;
    return [seen, reply.status, reply.body['code']];
  };

  it('MP-14-10a expired while waiting on the audit chain: no mandate command applies after its mandate:manage grant ran out', async () => {
    const toRevoke = String(detail(await w.file(w.admin, { label: 'To revoke' }))['mandateId']);
    const promoted = await w.as(w.admin, 'graduation.promote', {
      classId: w.cls['aShare'],
      ceiling: AUD(300),
      expiresAt: inDays(5),
    });
    expect(promoted.status).toBe(200);
    const before = await w.snapshot();
    const cases: readonly [string, Record<string, unknown>][] = [
      [
        'mandate.file',
        {
          clientId: w.clientA,
          classes: ['social.post'],
          ceiling: AUD(100),
          expiresAt: inDays(1),
          label: 'Posts approved',
        },
      ],
      ['mandate.revoke', { mandateId: toRevoke }],
      ['graduation.promote', { classId: w.cls['aReply'], ceiling: AUD(100), expiresAt: inDays(5) }],
      ['graduation.demote', { classId: w.cls['aShare'] }],
    ];
    const raced: unknown[] = [];
    for (const [name, body] of cases) {
      // eslint-disable-next-line no-await-in-loop -- one race at a time
      raced.push([name, ...(await expiredWhileChained(name, body))]);
    }
    expect(raced).toStrictEqual(
      cases.map(([name]) => [name, { wrote: true, live: true }, 403, 'SCOPE_NOT_GRANTED']),
    );
    expect(await w.snapshot()).toBe(before);
  }, 120_000);

  it('MP-14-10a signed out through bravo after the last session read: the sign-out waits for the mandate it admitted', async () => {
    const { presented, bearer } = await signedIn(signer);
    let release!: () => void;
    const stopped = new Promise<void>((reached) => {
      stop.armed = async () => {
        reached();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      };
    });
    const before = await w.mandateRows();
    const answer = send(bearer, 'mandate.file', {
      clientId: w.clientA,
      classes: ['social.post'],
      ceiling: AUD(100),
      expiresAt: inDays(1),
      label: 'Posts approved',
    });
    await stopped;
    let finished = false;
    const caller = {
      database: w.controls.fixture.db.app,
      businessId: w.bravo,
      presented,
      accessToken: bearer,
    };
    const ending = signOutSession(caller, {}, provider).finally(() => {
      finished = true;
    });
    const url = new URL(String(serverUrl));
    url.pathname = `/${w.controls.fixture.db.name}`;
    const waited = await signOutWaits(url.toString(), () => finished);
    release();
    const [reply, ended] = await Promise.all([answer, ending]);
    const later = await send(bearer, 'mandate.revoke', { mandateId: randomUUID() });
    expect([waited, ended, reply.status, [later.status, later.body['code']]]).toStrictEqual([
      true,
      { ended: 1, signedOutAtProvider: true },
      200,
      [401, 'AUTH_SESSION_EXPIRED'],
    ]);
    expect(await w.mandateRows()).toBe(before + 1);
  }, 60_000);
});
