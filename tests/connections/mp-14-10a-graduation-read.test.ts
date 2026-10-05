// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one ticket's named cases over one seeded world */
//
// MP-14-10a, the data half: the per-client graduation region on Connections
// & signal and core's standing mandate check, over HTTP and real transactions
// against a real database. Each case is named after the acceptance line or
// supporting checklist line it proves (U39).
//
// Graduation records are written by the agent loops as decisions land (AW-01,
// not built), and mandates by the mandate commands (the next piece), so the
// cases seed both as the database owner. The clients are real clients of the
// business (`clients`, C32); client B's name carries a planted record canary,
// so the isolation cases can look for it where it must not be.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { authorised, post, tokenFor, type Answer } from '../api/fixture.ts';
import { createControls, type Controls } from '../api/controls-fixture.ts';
import {
  classMatches,
  createClient,
  type TenantQuery,
} from '../../packages/core-records/src/index.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { standingMandateVerdict } from '../../packages/core-runtime/src/index.ts';
import type {
  ConnectionGraduationResult,
  GraduationRowView,
} from '../../packages/core-wire/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();
const RECORD_CANARY = `record-canary-${randomUUID()}`;
const BRAVO_CANARY = `bravo-canary-${randomUUID()}`;

const path = (business: string, name: string): string =>
  `/api/b/${business}/${name.replace('.', '/')}`;

const pause = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

type Question = Parameters<typeof standingMandateVerdict>[1];

/** A promise and the function that settles it. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** The backend a transaction runs on. */
async function backendOf(tx: Pick<TenantQuery, 'query'>): Promise<number> {
  const rows = await tx.query<{ readonly pid: number }>('select pg_backend_pid() as pid');
  return Number(rows[0]?.pid);
}

/** A transaction that records every statement sent through it, then sends it. */
const recording = (tx: TenantQuery, sent: string[]): TenantQuery => ({
  businessId: tx.businessId,
  query: async <Row>(text: string, parameters?: readonly unknown[]) => {
    sent.push(text);
    return await tx.query<Row>(text, parameters);
  },
});

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('MP-14-10a graduation region and mandate check', () => {
  let controls: Controls;
  let admin: Member;
  let clientReader: Member;
  let plain: Member;
  let bravoAdmin: Member;
  let alpha: string;
  let bravo: string;
  let clientA: string;
  let clientB: string;
  let bravoClient: string;
  const clientALabel = 'Client A';
  const clientBLabel = `Client B ${RECORD_CANARY}`;
  const cls: Record<string, string> = {};
  const answers: Answer[] = [];

  const as = async (who: Member, name: string, business = 'alpha'): Promise<Answer> => {
    const answer = await post(
      controls.api,
      path(business, name),
      { operationId: randomUUID() },
      authorised(await tokenFor(who.presented.subject)),
    );
    answers.push(answer);
    return answer;
  };

  const region = async (who: Member, business = 'alpha'): Promise<ConnectionGraduationResult> => {
    const answer = await as(who, 'connection.graduation', business);
    expect(answer.status).toBe(200);
    return answer.body as unknown as ConnectionGraduationResult;
  };

  const rowOf = async (id: string): Promise<GraduationRowView | undefined> =>
    (await region(admin)).rows.find((one) => one.id === id);

  const verdict = async (question: Partial<Question>, business = alpha) =>
    await controls.fixture.db.app.withBusiness(
      business,
      async (tx) =>
        await standingMandateVerdict(tx, {
          clientId: clientA,
          actionClass: 'report.send',
          valueMinor: 5000,
          currency: 'AUD',
          ...question,
        }),
    );

  /** A mandate as the commands will file it, written by the owner. */
  const seedMandate = async (
    row: {
      readonly client?: string;
      readonly classes: readonly string[];
      readonly refuses?: boolean;
      readonly ceilingMinor?: number;
      readonly currency?: string;
      readonly expires?: string;
      readonly graduationClass?: string;
      readonly label?: string;
    },
    business = alpha,
    author = admin,
  ): Promise<string> => {
    const id = randomUUID();
    const refuses = row.refuses ?? false;
    await controls.fixture.db.admin.execute(
      `insert into public.standing_mandates
         (business_id, id, client_id, classes, refuses, ceiling_minor, currency, expires_at,
          label, graduation_class, authored_by_actor_id)
       values ($1, $2, $3, $4, $5, $6, $7, now() + $8::interval, $9, $10, $11)`,
      [
        business,
        id,
        row.client ?? clientA,
        row.classes,
        refuses,
        refuses ? null : (row.ceilingMinor ?? 10_000),
        refuses ? null : (row.currency ?? 'AUD'),
        row.expires ?? '30 days',
        row.label ?? 'A standing approval',
        row.graduationClass ?? null,
        author.actorId,
      ],
    );
    return id;
  };

  const revoke = async (id: string): Promise<void> => {
    await controls.fixture.db.admin.execute(
      `update public.standing_mandates
          set revoked_at = clock_timestamp(), revoked_by_actor_id = authored_by_actor_id,
              revision = revision + 1
        where id = $1`,
      [id],
    );
  };

  const mandateRows = async (): Promise<number> =>
    await controls.count('select count(*) as n from public.standing_mandates', []);

  async function seedClass(
    business: string,
    client: string,
    actionClass: string,
    earned: string,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<string> {
    const id = randomUUID();
    await controls.fixture.db.admin.execute(
      `insert into public.graduation_classes
         (business_id, id, client_id, action_class, class_label, clearance, earned,
          never_why, approved, edited, rejected, since, note)
       values ($1, $2, $3, $4, $5, 'Draft', $6, $7, $8, 1, $9, '2026-08-01', $10)`,
      [
        business,
        id,
        client,
        actionClass,
        extra['label'] ?? `Class ${actionClass}`,
        earned,
        extra['neverWhy'] ?? null,
        extra['approved'] ?? 30,
        extra['rejected'] ?? 0,
        extra['note'] ?? '',
      ],
    );
    return id;
  }

  /**
   * Wait, bounded, until a backend is parked on a lock `holder` holds, running
   * a statement on `table`. Until then nothing shows the competing statement
   * reached the lock while it was held, and a case proves a sequence, not a
   * wait. The owner's connection asks; recursion, since the lint forbids
   * awaiting in a loop.
   */
  const blockedBy = async (
    holder: number,
    table: string,
    deadline = Date.now() + 10_000,
  ): Promise<void> => {
    const waiting = await controls.count(
      `select count(*) as n from pg_stat_activity
        where $1::int = any(pg_blocking_pids(pid)) and query like '%' || $2 || '%'`,
      [holder, table],
    );
    if (waiting > 0) return;
    if (Date.now() > deadline) {
      throw new Error(`mp-14-10a: no statement on ${table} ever waited on backend ${holder}`);
    }
    await pause(25);
    await blockedBy(holder, table, deadline);
  };

  const madeClient = async (business: string, name: string, by: Member): Promise<string> =>
    await controls.fixture.db.app.withBusiness(business, async (tx) => {
      const made = await createClient(tx, name, by.actorId);
      if (!made.ok) throw new Error('mp-14-10a: the client was not made');
      return made.value;
    });

  // eslint-disable-next-line max-lines-per-function -- the world, built in one place
  beforeAll(async () => {
    controls = await createControls('mp1410a');
    const { db, business } = controls.fixture;
    alpha = business;
    admin = controls.manager;
    clientReader = await enrol(db.app, business, 'clientreader');
    plain = await enrol(db.app, business, 'plain');
    clientA = await madeClient(alpha, clientALabel, admin);
    clientB = await madeClient(alpha, clientBLabel, admin);
    const whole = { kind: 'business', id: null } as const;
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, admin, 'read', whole, false, 'connection');
      await grantTo(tx, clientReader, 'read', { kind: 'party', id: clientA }, false, 'connection');
      await grantTo(tx, plain, 'read', whole, false, 'task');
    });

    cls['aPost'] = await seedClass(alpha, clientA, 'social.post', 'ready');
    cls['aReply'] = await seedClass(alpha, clientA, 'social.reply', 'ready');
    cls['aLike'] = await seedClass(alpha, clientA, 'social.like', 'ready');
    cls['aBudget'] = await seedClass(alpha, clientA, 'ads.budget', 'never', {
      neverWhy: 'ceiling',
    });
    cls['aReport'] = await seedClass(alpha, clientA, 'report.send', 'short', { approved: 12 });
    cls['aEmail'] = await seedClass(alpha, clientA, 'email.send', 'mixed', { rejected: 4 });
    cls['aInvoice'] = await seedClass(alpha, clientA, 'billing.invoice', 'none', { approved: 0 });
    cls['bPost'] = await seedClass(alpha, clientB, 'social.post', 'ready', {
      note: `B note ${RECORD_CANARY}`,
    });

    bravo = await insertBusiness(db.app, 'bravo');
    await installSpine(db.app, bravo);
    bravoAdmin = await enrol(db.app, bravo, 'bravoadmin');
    await db.app.withBusiness(bravo, async (tx) => {
      await grantTo(tx, bravoAdmin, 'read', whole, false, 'connection');
    });
    bravoClient = await madeClient(bravo, `Bravo ${BRAVO_CANARY}`, bravoAdmin);
    cls['bravoPost'] = await seedClass(bravo, bravoClient, 'social.post', 'ready');
  }, 120_000);

  afterAll(async () => {
    await controls?.drop();
  });

  it('MP-14-10a one select drives all three sections: one read carries every client and its scope list', async () => {
    const result = await region(admin);
    expect(result.clients.map((one) => [one.id, one.label])).toStrictEqual([
      [clientA, clientALabel],
      [clientB, clientBLabel],
    ]);
    const a = result.clients.find((one) => one.id === clientA);
    expect(a?.scopes).toStrictEqual([
      '*',
      'ads.*',
      'billing.*',
      'email.*',
      'report.*',
      'social.*',
      'ads.budget',
      'billing.invoice',
      'email.send',
      'report.send',
      'social.like',
      'social.post',
      'social.reply',
    ]);
    expect(result.rows.filter((one) => one.clientId === clientA)).toHaveLength(7);
    const never = result.rows.find((one) => one.id === cls['aBudget']);
    expect([never?.state, never?.neverWhy]).toStrictEqual(['never', 'ceiling']);
  });

  it('MP-14-10a every reachable client is in the client list, one with no graduation rows included', async () => {
    const clientCLabel = 'Client C with no history';
    const clientC = await madeClient(alpha, clientCLabel, admin);
    const clientCReader = await enrol(controls.fixture.db.app, alpha, 'clientcreader');
    await controls.fixture.db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, clientCReader, 'read', { kind: 'party', id: clientC }, false, 'connection');
    });
    const refusal = await seedMandate({
      client: clientC,
      classes: ['*'],
      refuses: true,
      label: 'Nothing runs on its own for C',
    });
    const seen = [await region(admin), await region(clientCReader)];
    for (const result of seen) {
      expect(result.clients.find((one) => one.id === clientC)).toStrictEqual({
        id: clientC,
        label: clientCLabel,
        scopes: ['*'],
      });
      expect(result.rows.filter((one) => one.clientId === clientC)).toStrictEqual([]);
      expect(result.mandates.map((one) => one.id)).toContain(refusal);
      const listed = new Set(result.clients.map((one) => one.id));
      expect(result.mandates.filter((one) => !listed.has(one.clientId))).toStrictEqual([]);
    }
    await revoke(refusal);
  });

  it('MP-14-10a a class shows promoted only while its promoting mandate is live', async () => {
    const live = await seedMandate({ classes: ['social.reply'], graduationClass: 'social.reply' });
    const promoted = await rowOf(String(cls['aReply']));
    expect(promoted?.state).toBe('promoted');
    expect(promoted?.promotedAt).not.toBeNull();
    await revoke(live);
    expect((await rowOf(String(cls['aReply'])))?.state).toBe('ready');
    expect((await region(admin)).mandates.map((one) => one.id)).not.toContain(live);

    const lapsed = await seedMandate({
      classes: ['social.reply'],
      graduationClass: 'social.reply',
      expires: '1 second',
    });
    await pause(1500);
    const result = await region(admin);
    expect(result.rows.find((one) => one.id === cls['aReply'])?.state).toBe('ready');
    expect(result.mandates.find((one) => one.id === lapsed)?.expired).toBe(true);
    await revoke(lapsed);
  });

  it('MP-14-10a a refusal holds matching classes of its own client and revoking it releases them', async () => {
    const promote = await seedMandate({ classes: ['social.like'], graduationClass: 'social.like' });
    const refusal = await seedMandate({
      classes: ['social.*'],
      refuses: true,
      label: 'Nothing social runs on its own for A this month',
    });
    const held = await region(admin);
    for (const id of [cls['aLike'], cls['aPost']]) {
      const row = held.rows.find((one) => one.id === id);
      expect([row?.state, row?.heldBy]).toStrictEqual(['held', refusal]);
    }
    // Client B's social.post is another client's and is not held; a class
    // that never earned the bar has nothing for the refusal to hold.
    expect(held.rows.find((one) => one.id === cls['bPost'])?.state).toBe('ready');
    expect(held.rows.find((one) => one.id === cls['aReport'])?.state).toBe('short');
    await revoke(refusal);
    const released = await region(admin);
    expect(released.rows.find((one) => one.id === cls['aLike'])?.state).toBe('promoted');
    expect(released.rows.find((one) => one.id === cls['aPost'])?.state).toBe('ready');
    await revoke(promote);
  });

  it('MP-14-10a core checks class, scope, ceiling, currency, client and revocation at the effect', async () => {
    const mandateId = await seedMandate({ classes: ['report.*'], ceilingMinor: 10_000 });
    expect(await verdict({})).toStrictEqual({ covered: true, mandateId });
    expect(await verdict({ valueMinor: 10_000 })).toStrictEqual({ covered: true, mandateId });
    expect(await verdict({ valueMinor: 10_001 })).toStrictEqual({
      covered: false,
      reason: 'over-ceiling',
      mandateId,
    });
    expect(await verdict({ currency: 'USD' })).toStrictEqual({
      covered: false,
      reason: 'other-currency',
      mandateId,
    });
    expect(await verdict({ actionClass: 'social.post' })).toStrictEqual({
      covered: false,
      reason: 'none',
    });
    expect(await verdict({ clientId: clientB })).toStrictEqual({ covered: false, reason: 'none' });
    await expect(verdict({ valueMinor: 1.5 })).rejects.toThrow(RangeError);
    await revoke(mandateId);
    expect(await verdict({})).toStrictEqual({ covered: false, reason: 'none' });
  });

  it('MP-14-10a a mandate word is the whole account, a family or a class, and nothing else is stored or matched', async () => {
    const hostile = [
      'report*',
      'rep*',
      'report.',
      '*.send',
      '.*',
      'report.s*',
      'REPORT.*',
      ' report.*',
      'report.send.*',
      'report.send ',
      'r%',
      'report..send',
      '',
    ];
    const before = await mandateRows();
    for (const word of hostile) {
      // eslint-disable-next-line no-await-in-loop -- one word at a time
      await expect(seedMandate({ classes: [word] }), word).rejects.toMatchObject({
        code: '23514',
      });
      // A refusal with the word would hold nothing, so it is refused alike.
      // eslint-disable-next-line no-await-in-loop -- one word at a time
      await expect(
        seedMandate({ classes: ['*', word], refuses: true }),
        word,
      ).rejects.toMatchObject({ code: '23514' });
      expect(classMatches(word, 'report.send'), word).toBe(false);
    }
    expect(await mandateRows()).toBe(before);
    // A family word is the first part only, so no deeper word covers a deeper class.
    expect(classMatches('report.send.*', 'report.send.daily')).toBe(false);
    expect(classMatches('report.*', 'report.send.daily')).toBe(true);
    for (const word of ['*', 'report.*', 'report.send']) {
      // eslint-disable-next-line no-await-in-loop -- one word at a time
      const id = await seedMandate({ classes: [word] });
      // eslint-disable-next-line no-await-in-loop -- one word at a time
      expect(await verdict({}), word).toStrictEqual({ covered: true, mandateId: id });
      // eslint-disable-next-line no-await-in-loop -- one word at a time
      await revoke(id);
    }
  });

  it('MP-14-10a core: an approval never covers a class a rule stopped or a class the client does not have', async () => {
    const all = await seedMandate({ classes: ['*'], ceilingMinor: 1_000_000 });
    expect(await verdict({ actionClass: 'ads.budget', valueMinor: 1 })).toStrictEqual({
      covered: false,
      reason: 'not-graduable',
    });
    expect(await verdict({ actionClass: 'social.share', valueMinor: 1 })).toStrictEqual({
      covered: false,
      reason: 'not-graduable',
    });
    // A class the list shows short is one a person may still approve directly.
    expect(await verdict({ actionClass: 'report.send', valueMinor: 1 })).toStrictEqual({
      covered: true,
      mandateId: all,
    });
    await revoke(all);
  });

  it('MP-14-10a core: a malformed question is refused before anything is read', async () => {
    const asked = async (question: Partial<Question>): Promise<readonly string[]> => {
      const sent: string[] = [];
      await controls.fixture.db.app
        .withBusiness(alpha, async (tx) => {
          await standingMandateVerdict(recording(tx, sent), {
            clientId: clientA,
            actionClass: 'report.send',
            valueMinor: 5000,
            currency: 'AUD',
            ...question,
          });
        })
        .catch((error: unknown) => {
          if (!(error instanceof RangeError)) throw error;
          sent.push('RangeError');
        });
      return sent;
    };
    // The recorder sees what a well-formed question reads.
    expect((await asked({})).length).toBeGreaterThan(0);
    for (const question of [
      { actionClass: '' },
      { actionClass: 'report' },
      { actionClass: 'Report.send' },
      { actionClass: 'report.' },
      { actionClass: 'report.*' },
      { actionClass: '*' },
      { currency: 'aud' },
      { currency: 'AUDX' },
      { clientId: 'not-a-uuid' },
      { valueMinor: -1 },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one question at a time
      expect(await asked(question), JSON.stringify(question)).toStrictEqual(['RangeError']);
    }
  });

  it('MP-14-10a core: a live matching refusal wins over an approval at the effect', async () => {
    const question = { actionClass: 'billing.invoice', valueMinor: 1 };
    const approval = await seedMandate({ classes: ['billing.invoice'], ceilingMinor: 100_000 });
    const refusal = await seedMandate({ classes: ['billing.*'], refuses: true });
    expect(await verdict(question)).toStrictEqual({
      covered: false,
      reason: 'refused',
      mandateId: refusal,
    });
    await revoke(refusal);
    expect(await verdict(question)).toStrictEqual({ covered: true, mandateId: approval });
    await revoke(approval);
  });

  it('MP-14-10a core: expiry is judged on the database clock after the lock wait', async () => {
    const mandateId = await seedMandate({ classes: ['email.send'], expires: '2 seconds' });
    const locked = deferred();
    const release = deferred();
    let holder = 0;
    // The lock is held on the owner's own connection, not the check's.
    const held = controls.fixture.db.admin.transaction(async (execute) => {
      holder = await backendOf({ query: execute });
      await execute('select id from public.standing_mandates where id = $1 for update', [
        mandateId,
      ]);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const checking = verdict({ actionClass: 'email.send', valueMinor: 1 });
    const liveNow = async (): Promise<number> =>
      await controls.count(
        `select count(*) as n from public.standing_mandates
          where id = $1 and expires_at > clock_timestamp()`,
        [mandateId],
      );
    // The check is parked on the lock while the mandate is still live ...
    await blockedBy(holder, 'standing_mandates');
    expect(await liveNow()).toBe(1);
    // ... and is let go only once it has expired.
    await pause(2000);
    expect(await liveNow()).toBe(0);
    release.resolve();
    await held;
    // The check began while the mandate was live and waited on the lock
    // past its expiry: it is judged expired, not covered.
    expect(await checking).toStrictEqual({ covered: false, reason: 'expired', mandateId });
    await revoke(mandateId);
  });

  it('MP-14-10a revoking stops pre-approval at once, and an effect already past its check is not undone', async () => {
    const mandateId = await seedMandate({ classes: ['email.send'] });
    let revokeDone = false;
    let revoking: Promise<void> | undefined;
    const effect = await controls.fixture.db.app.withBusiness(alpha, async (tx) => {
      const checked = await standingMandateVerdict(tx, {
        clientId: clientA,
        actionClass: 'email.send',
        valueMinor: 1,
        currency: 'AUD',
      });
      // The revoke runs on the owner's own connection, not this one.
      revoking = (async () => {
        await revoke(mandateId);
        revokeDone = true;
      })();
      // The revoke is parked on the share lock this effect holds.
      await blockedBy(await backendOf(tx), 'standing_mandates');
      expect(revokeDone).toBe(false);
      return checked;
    });
    expect(effect).toStrictEqual({ covered: true, mandateId });
    await revoking;
    expect(revokeDone).toBe(true);
    expect(await verdict({ actionClass: 'email.send', valueMinor: 1 })).toStrictEqual({
      covered: false,
      reason: 'none',
    });
  });

  it('MP-14-10a a refusal being filed waits for a check under way, and the next check sees it', async () => {
    const filingPool = connect(controls.fixture.db.appUrl, { source: 'runtime', max: 1 });
    const approval = await seedMandate({ classes: ['email.send'] });
    let filed = false;
    let filing: Promise<string> | undefined;
    const effect = await controls.fixture.db.app.withBusiness(alpha, async (tx) => {
      const checked = await standingMandateVerdict(tx, {
        clientId: clientA,
        actionClass: 'email.send',
        valueMinor: 1,
        currency: 'AUD',
      });
      // The refusal is filed as the application, on a connection of its own:
      // the insert itself takes the client's row, under the application's own
      // grants and tenancy, whatever its writer remembers to lock.
      filing = (async () => {
        const id = randomUUID();
        await filingPool.withBusiness(alpha, async (other) => {
          await other.query(
            `insert into public.standing_mandates
               (business_id, id, client_id, classes, refuses, expires_at, label,
                authored_by_actor_id)
             values ((select public.app_business_id()), $1, $2, '{email.*}', true,
                     now() + interval '1 day', 'No email runs on its own for A', $3)`,
            [id, clientA, admin.actorId],
          );
        });
        filed = true;
        return id;
      })();
      // The insert is parked on the client's row this check holds.
      await blockedBy(await backendOf(tx), 'standing_mandates');
      expect(filed).toBe(false);
      return checked;
    });
    expect(effect).toStrictEqual({ covered: true, mandateId: approval });
    const refusal = String(await filing);
    expect(filed).toBe(true);
    expect(await verdict({ actionClass: 'email.send', valueMinor: 1 })).toStrictEqual({
      covered: false,
      reason: 'refused',
      mandateId: refusal,
    });
    await revoke(refusal);
    await revoke(approval);
    await filingPool.close();
  });

  it('MP-14-10a a graduation row revision moves by one or not at all', async () => {
    const stepped = async (step: number): Promise<string> => {
      try {
        await controls.fixture.db.app.withBusiness(alpha, async (tx) => {
          await tx.query(
            'update public.graduation_classes set revision = revision + $2 where id = $1',
            [cls['aInvoice'], step],
          );
        });
        return 'ok';
      } catch (error) {
        return String((error as { readonly code?: unknown }).code);
      }
    };
    expect(await stepped(5)).toBe('23001');
    expect(await stepped(-1)).toBe('23001');
    expect(await stepped(1)).toBe('ok');
  });

  it('MP-14-10a a promoted class whose record turns never shows never, as core treats it', async () => {
    const promote = await seedMandate({
      classes: ['social.reply'],
      graduationClass: 'social.reply',
    });
    expect((await rowOf(String(cls['aReply'])))?.state).toBe('promoted');
    const setEarned = async (earned: string, why: string | null): Promise<void> => {
      await controls.fixture.db.admin.execute(
        'update public.graduation_classes set earned = $2, never_why = $3 where id = $1',
        [cls['aReply'], earned, why],
      );
    };
    await setEarned('never', 'audience');
    const row = await rowOf(String(cls['aReply']));
    expect([row?.state, row?.promotedAt]).toStrictEqual(['never', null]);
    expect(await verdict({ actionClass: 'social.reply', valueMinor: 1 })).toStrictEqual({
      covered: false,
      reason: 'not-graduable',
    });
    await setEarned('ready', null);
    await revoke(promote);
  });

  it('MP-14-10a a promotion names one action class, and every word in a list is known, a null one included', async () => {
    await expect(seedMandate({ classes: ['*'], graduationClass: '*' })).rejects.toMatchObject({
      code: '23514',
    });
    const known = await controls.fixture.db.admin.execute<{ readonly ok: boolean }>(
      `select public.standing_mandate_words_known(array['*', null]::text[]) as ok`,
    );
    expect(known[0]?.ok).toBe(false);
  });

  it('MP-14-10a a revocation is stamped by the database and moves the revision by one', async () => {
    const id = await seedMandate({ classes: ['social.post'] });
    const started = await controls.fixture.db.admin.execute<{ readonly at: Date }>(
      'select clock_timestamp() as at',
    );
    const stepped = async (step: number): Promise<string> => {
      try {
        await controls.fixture.db.app.withBusiness(alpha, async (tx) => {
          await tx.query(
            `update public.standing_mandates
                set revoked_at = now() - interval '1 year', revoked_by_actor_id = $2,
                    revision = revision + $3
              where id = $1`,
            [id, admin.actorId, step],
          );
        });
        return 'ok';
      } catch (error) {
        return String((error as { readonly code?: unknown }).code);
      }
    };
    expect(await stepped(5)).toBe('23001');
    expect(await stepped(1)).toBe('ok');
    const row = await controls.fixture.db.admin.execute<{
      readonly revoked_at: Date;
      readonly revision: string;
    }>('select revoked_at, revision from public.standing_mandates where id = $1', [id]);
    expect(row[0]?.revision).toBe('2');
    expect(row[0]?.revoked_at.getTime()).toBeGreaterThanOrEqual(started[0]?.at.getTime() ?? 0);
  });

  it('MP-14-10a a mandate is written once: the application can revoke it, never edit, backdate or revive it', async () => {
    const id = await seedMandate({ classes: ['social.post'] });
    const asApp = async (sql: string, parameters: readonly unknown[]): Promise<string> => {
      try {
        await controls.fixture.db.app.withBusiness(alpha, async (tx) => {
          await tx.query(sql, parameters);
        });
        return 'ok';
      } catch (error) {
        return String((error as { readonly code?: unknown }).code);
      }
    };
    expect(
      await asApp('update public.standing_mandates set label = $2 where id = $1', [id, 'x']),
    ).toBe('42501');
    expect(
      await asApp(
        `insert into public.standing_mandates
           (business_id, id, client_id, classes, refuses, ceiling_minor, currency, expires_at,
            label, authored_by_actor_id, created_at)
         values ((select public.app_business_id()), $1, $2, '{social.post}', false, 1, 'AUD',
                 now() + interval '1 day', 'backdated', $3, now() - interval '1 year')`,
        [randomUUID(), clientA, admin.actorId],
      ),
    ).toBe('42501');
    expect(
      await asApp(
        `update public.standing_mandates
            set revoked_at = clock_timestamp(), revoked_by_actor_id = $2, revision = revision + 1
          where id = $1`,
        [id, admin.actorId],
      ),
    ).toBe('ok');
    expect(
      await asApp(
        'update public.standing_mandates set revoked_at = null, revoked_by_actor_id = null where id = $1',
        [id],
      ),
    ).toBe('23001');
    const after = await controls.fixture.db.admin.execute<{ readonly revoked: boolean }>(
      'select revoked_at is not null as revoked from public.standing_mandates where id = $1',
      [id],
    );
    expect(after[0]?.revoked).toBe(true);
  });

  it('MP-14-10a the read and the scope bar add no audit event beyond the read operation row', async () => {
    const count = async (): Promise<number> =>
      await controls.count(`select count(*) as n from public.audit_events where actor_id = $1`, [
        clientReader.actorId,
      ]);
    const before = await count();
    const mandatesBefore = await mandateRows();
    await region(clientReader);
    expect(await count()).toBe(before + 1);
    const last = await controls.fixture.db.admin.execute<{ readonly command: string }>(
      `select command from public.audit_events where actor_id = $1 order by seq desc limit 1`,
      [clientReader.actorId],
    );
    expect(last[0]?.command).toBe('connection.graduation');
    expect(await mandateRows()).toBe(mandatesBefore);
  });

  it('MP-14-10a refusal connection:read: a member without it is refused the region and shown nothing', async () => {
    const answer = await as(plain, 'connection.graduation');
    expect([answer.status, answer.body['code']]).toStrictEqual([403, 'SCOPE_NOT_GRANTED']);
    expect(answer.body['rows']).toBeUndefined();
    expect(JSON.stringify(answer.body)).not.toContain(clientA);
  });

  it('MP-14-10a isolation: an agent under a live delegation reads none of it', async () => {
    const live = await seedMandate({ classes: ['social.post'], label: `Agent ${RECORD_CANARY}` });
    const task = await controls.createTask('agent crossing');
    const proposal = await controls.propose(task.id, task.revision);
    const picked = await controls.pickup(await controls.approve(proposal));
    const answer = await controls.asAgent(
      'connection.graduation',
      {},
      String(picked['credential']),
    );
    answers.push(answer);
    expect(answer.status).toBe(403);
    expect(String(answer.body['code'])).toMatch(/^(DELEGATION_|AUTH_)/u);
    expect(answer.body['rows']).toBeUndefined();
    const text = JSON.stringify(answer.body);
    for (const mine of [clientA, live, RECORD_CANARY]) expect(text).not.toContain(mine);
    await revoke(live);
  });

  it('MP-14-10a isolation: another business never sees, counts or is covered by these mandates', async () => {
    const ours = await seedMandate({ classes: ['social.post'], label: `Ours ${RECORD_CANARY}` });
    const theirs = await seedMandate(
      { client: bravoClient, classes: ['social.post'], label: `Theirs ${BRAVO_CANARY}` },
      bravo,
      bravoAdmin,
    );
    const seen = await region(bravoAdmin, 'bravo');
    expect(seen.rows.map((one) => one.id)).toStrictEqual([cls['bravoPost']]);
    expect(seen.mandates.map((one) => one.id)).toStrictEqual([theirs]);
    expect(seen.clients.map((one) => one.id)).toStrictEqual([bravoClient]);
    const text = JSON.stringify(seen);
    for (const mine of [clientA, clientB, ours, RECORD_CANARY]) expect(text).not.toContain(mine);
    // Core's check in bravo's transaction, asked about alpha's client, sees nothing.
    expect(await verdict({ actionClass: 'social.post', valueMinor: 1 }, bravo)).toStrictEqual({
      covered: false,
      reason: 'none',
    });
    expect(await verdict({ actionClass: 'social.post', valueMinor: 1 })).toStrictEqual({
      covered: true,
      mandateId: ours,
    });
    expect(JSON.stringify(await region(admin))).not.toContain(BRAVO_CANARY);
    await revoke(ours);
    await revoke(theirs);
  });

  it('MP-14-10a isolation: a client-scoped reader sees that client only, in rows, mandates and the client list', async () => {
    const onA = await seedMandate({ classes: ['social.post'] });
    const onB = await seedMandate({
      client: clientB,
      classes: ['social.post'],
      label: `For B ${RECORD_CANARY}`,
    });
    const result = await region(clientReader);
    expect(result.clients.map((one) => one.id)).toStrictEqual([clientA]);
    expect(new Set(result.rows.map((one) => one.clientId))).toStrictEqual(new Set([clientA]));
    expect(result.mandates.map((one) => one.id)).toStrictEqual([onA]);
    const text = JSON.stringify(result);
    for (const theirs of [clientB, onB, RECORD_CANARY]) expect(text).not.toContain(theirs);
    await revoke(onA);
    await revoke(onB);
  });

  it('MP-14-10a parity: the region is connection:read, person only', () => {
    const row = COMMAND_SURFACE.find((one) => one.name === 'connection.graduation');
    expect([row?.kind, row?.collection, row?.action, row?.agent]).toStrictEqual([
      'read',
      'connection',
      'read',
      'never',
    ]);
  });
});
