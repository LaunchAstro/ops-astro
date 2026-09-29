// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one ticket's named cases over one seeded world */
//
// MP-14-10a: the client scope bar, graduation and standing mandates on
// Connections & signal, over HTTP against a real database. Each case is named
// after the acceptance line or supporting checklist line it proves (U39, #493).
//
// Graduation records are written by the agent loops as decisions land (AW-01,
// not built), so the cases seed them as the database owner. Mandates are only
// ever written through the commands. Client B's labels carry a planted
// canary, so the isolation cases can look for it where it must not be.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { authorised, post, tokenFor, type Answer } from '../api/fixture.ts';
import { createControls, type Controls } from '../api/controls-fixture.ts';
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

const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();
const AUD = (amountMinor: number): { amountMinor: number; currency: string } => ({
  amountMinor,
  currency: 'AUD',
});

const detail = (answer: Answer): Record<string, unknown> =>
  answer.body['detail'] as Record<string, unknown>;

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('MP-14-10a graduation and standing mandates', () => {
  let controls: Controls;
  let admin: Member;
  let reader: Member;
  let clientManager: Member;
  let plain: Member;
  let bravoAdmin: Member;
  let alpha: string;
  let bravo: string;
  const clientA = randomUUID();
  const clientB = randomUUID();
  const clientALabel = 'Client A';
  const clientBLabel = `Client B ${RECORD_CANARY}`;
  const cls: Record<string, string> = {};
  const answers: Answer[] = [];

  const as = async (
    who: Member,
    name: string,
    body: Readonly<Record<string, unknown>>,
    business = 'alpha',
  ): Promise<Answer> => {
    const answer = await post(
      controls.api,
      path(business, name),
      { operationId: randomUUID(), ...body },
      authorised(await tokenFor(who.presented.subject)),
    );
    answers.push(answer);
    return answer;
  };

  const region = async (who: Member, business = 'alpha'): Promise<ConnectionGraduationResult> => {
    const answer = await as(who, 'connection.graduation', {}, business);
    expect(answer.status).toBe(200);
    return answer.body as unknown as ConnectionGraduationResult;
  };

  const rowOf = async (id: string): Promise<GraduationRowView | undefined> =>
    (await region(admin)).rows.find((one) => one.id === id);

  const file = async (
    who: Member,
    body: Readonly<Record<string, unknown>>,
    business = 'alpha',
  ): Promise<Answer> =>
    await as(
      who,
      'mandate.file',
      {
        clientId: clientA,
        classes: ['social.post'],
        ceiling: AUD(50_000),
        expiresAt: inDays(30),
        label: 'Posts for A under five hundred dollars are fine',
        ...body,
      },
      business,
    );

  const verdict = async (
    question: Partial<Parameters<typeof standingMandateVerdict>[1]>,
    business = alpha,
  ): Promise<Awaited<ReturnType<typeof standingMandateVerdict>>> =>
    await controls.fixture.db.app.withBusiness(
      business,
      async (tx) =>
        await standingMandateVerdict(tx, {
          clientId: clientA,
          actionClass: 'report.send',
          valueMinor: 5000,
          currency: 'AUD',
          at: new Date(),
          ...question,
        }),
    );

  const mandateRows = async (): Promise<number> =>
    await controls.count('select count(*) as n from public.standing_mandates', []);
  const liveMandates = async (): Promise<number> =>
    await controls.count(
      'select count(*) as n from public.standing_mandates where revoked_at is null',
      [],
    );

  async function seedClass(
    business: string,
    client: [string, string],
    actionClass: string,
    earned: string,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<string> {
    const id = randomUUID();
    await controls.fixture.db.admin.execute(
      `insert into public.graduation_classes
         (business_id, id, client_id, client_label, action_class, class_label, clearance, earned,
          never_why, approved, edited, rejected, since, note)
       values ($1, $2, $3, $4, $5, $6, 'Draft', $7, $8, $9, 1, $10, '2026-08-01', $11)`,
      [
        business,
        id,
        client[0],
        client[1],
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

  // eslint-disable-next-line max-lines-per-function -- the world, built in one place
  beforeAll(async () => {
    controls = await createControls('mp1410a');
    const { db, business } = controls.fixture;
    alpha = business;
    admin = controls.manager;
    reader = await enrol(db.app, business, 'reader');
    clientManager = await enrol(db.app, business, 'clientmanager');
    plain = await enrol(db.app, business, 'plain');
    const whole = { kind: 'business', id: null } as const;
    const partyA = { kind: 'party', id: clientA } as const;
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, admin, 'manage', whole, false, 'mandate');
      await grantTo(tx, admin, 'read', whole, false, 'connection');
      await grantTo(tx, reader, 'read', whole, false, 'connection');
      await grantTo(tx, reader, 'read', whole, false, 'mandate');
      await grantTo(tx, reader, 'write', whole, false, 'mandate');
      await grantTo(tx, clientManager, 'manage', partyA, false, 'mandate');
      await grantTo(tx, clientManager, 'read', partyA, false, 'connection');
      await grantTo(tx, plain, 'read', whole, false, 'task');
    });

    const a: [string, string] = [clientA, clientALabel];
    const b: [string, string] = [clientB, clientBLabel];
    cls['aPost'] = await seedClass(alpha, a, 'social.post', 'ready');
    cls['aReply'] = await seedClass(alpha, a, 'social.reply', 'ready');
    cls['aLike'] = await seedClass(alpha, a, 'social.like', 'ready');
    cls['aBudget'] = await seedClass(alpha, a, 'ads.budget', 'never', { neverWhy: 'ceiling' });
    cls['aReport'] = await seedClass(alpha, a, 'report.send', 'short', { approved: 12 });
    cls['aEmail'] = await seedClass(alpha, a, 'email.send', 'mixed', { rejected: 4 });
    cls['aInvoice'] = await seedClass(alpha, a, 'billing.invoice', 'none', { approved: 0 });
    cls['bPost'] = await seedClass(alpha, b, 'social.post', 'ready', {
      note: `B note ${RECORD_CANARY}`,
    });

    bravo = await insertBusiness(db.app, 'bravo');
    await installSpine(db.app, bravo);
    bravoAdmin = await enrol(db.app, bravo, 'bravoadmin');
    await db.app.withBusiness(bravo, async (tx) => {
      await grantTo(tx, bravoAdmin, 'manage', whole, false, 'mandate');
      await grantTo(tx, bravoAdmin, 'read', whole, false, 'connection');
    });
    cls['bravoPost'] = await seedClass(
      bravo,
      [randomUUID(), `Bravo ${BRAVO_CANARY}`],
      'social.post',
      'ready',
    );
  }, 120_000);

  afterAll(async () => {
    await controls?.drop();
  });

  it('MP-14-10a owner check: choose a client, file a standing approval with a limit and expiry, then revoke it; both are recorded', async () => {
    const filed = await file(admin, {});
    expect(filed.status).toBe(200);
    const mandateId = String(detail(filed)['mandateId']);
    const shown = (await region(admin)).mandates.find((one) => one.id === mandateId);
    expect(shown?.clientId).toBe(clientA);
    expect(shown?.ceiling).toStrictEqual(AUD(50_000));
    expect(shown?.classes).toStrictEqual(['social.post']);
    expect(shown?.authoredBy).toBe(admin.actorId);

    const revoked = await as(admin, 'mandate.revoke', { mandateId });
    expect(revoked.status).toBe(200);
    expect((await region(admin)).mandates.map((one) => one.id)).not.toContain(mandateId);
    const record = await controls.fixture.db.admin.execute<{
      readonly revoked_by_actor_id: string;
    }>(`select revoked_by_actor_id from public.standing_mandates where id = $1`, [mandateId]);
    expect(record[0]?.revoked_by_actor_id).toBe(admin.actorId);
  });

  it('MP-14-10a one select drives all three sections: one read carries every client and its scope list', async () => {
    const result = await region(admin);
    expect(result.clients.map((one) => one.id).toSorted()).toStrictEqual(
      [clientA, clientB].toSorted(),
    );
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
    const rowsA = result.rows.filter((one) => one.clientId === clientA);
    expect(rowsA).toHaveLength(7);
  });

  it('MP-14-10a the switch moves promoted and ready only when live, disabled with its reason otherwise', async () => {
    const before = await mandateRows();
    for (const id of [cls['aBudget'], cls['aReport'], cls['aEmail'], cls['aInvoice']]) {
      // eslint-disable-next-line no-await-in-loop -- one row at a time
      const answer = await as(admin, 'graduation.promote', {
        classId: id,
        ceiling: AUD(1000),
        expiresAt: inDays(7),
      });
      expect(answer.status).toBe(409);
      expect(answer.body['code']).toBe('TRANSITION_NOT_PERMITTED');
    }
    expect(await mandateRows()).toBe(before);
    const never = await rowOf(String(cls['aBudget']));
    expect([never?.state, never?.neverWhy]).toStrictEqual(['never', 'ceiling']);
    const demoteReady = await as(admin, 'graduation.demote', { classId: cls['aReply'] });
    expect(demoteReady.status).toBe(409);
    expect(demoteReady.body['code']).toBe('TRANSITION_NOT_PERMITTED');
  });

  it('MP-14-10a promoting writes the class standing mandate for this client, and demoting revokes it', async () => {
    const promoted = await as(admin, 'graduation.promote', {
      classId: cls['aReply'],
      ceiling: AUD(2000),
      expiresAt: inDays(14),
    });
    expect(promoted.status).toBe(200);
    const mandateId = String(detail(promoted)['mandateId']);
    const row = await rowOf(String(cls['aReply']));
    expect(row?.state).toBe('promoted');
    expect(row?.promotedAt).not.toBeNull();
    const mandate = (await region(admin)).mandates.find((one) => one.id === mandateId);
    expect([mandate?.clientId, mandate?.classes, mandate?.graduationClass]).toStrictEqual([
      clientA,
      ['social.reply'],
      'social.reply',
    ]);
    expect(mandate?.label).toContain('Class social.reply');

    const demoted = await as(admin, 'graduation.demote', { classId: cls['aReply'] });
    expect(demoted.status).toBe(200);
    expect((await rowOf(String(cls['aReply'])))?.state).toBe('ready');
    const revoked = await controls.count(
      'select count(*) as n from public.standing_mandates where id = $1 and revoked_at is not null',
      [mandateId],
    );
    expect(revoked).toBe(1);
  });

  it('MP-14-10a a refusal holds matching classes and revoking it releases them', async () => {
    const promoted = await as(admin, 'graduation.promote', {
      classId: cls['aLike'],
      ceiling: AUD(100),
      expiresAt: inDays(3),
    });
    expect(promoted.status).toBe(200);
    const refusal = await file(admin, {
      classes: ['social.*'],
      refuses: true,
      ceiling: null,
      label: 'Nothing social runs on its own for A this month',
    });
    expect(refusal.status).toBe(200);
    const refusalId = String(detail(refusal)['mandateId']);
    const held = await region(admin);
    for (const id of [cls['aLike'], cls['aPost']]) {
      const row = held.rows.find((one) => one.id === id);
      expect([row?.state, row?.heldBy]).toStrictEqual(['held', refusalId]);
    }
    // Client B's social.post is another client's and is not held.
    expect(held.rows.find((one) => one.id === cls['bPost'])?.state).toBe('ready');
    const blocked = await as(admin, 'graduation.promote', {
      classId: cls['aPost'],
      ceiling: AUD(100),
      expiresAt: inDays(3),
    });
    expect(blocked.status).toBe(409);

    expect((await as(admin, 'mandate.revoke', { mandateId: refusalId })).status).toBe(200);
    const released = await region(admin);
    expect(released.rows.find((one) => one.id === cls['aLike'])?.state).toBe('promoted');
    expect(released.rows.find((one) => one.id === cls['aPost'])?.state).toBe('ready');
    expect((await as(admin, 'graduation.demote', { classId: cls['aLike'] })).status).toBe(200);
  });

  it('MP-14-10a nothing files until the classes, client, ceiling and expiry are set, each from its list', async () => {
    const before = await mandateRows();
    const cases: readonly [Record<string, unknown>, string][] = [
      [{ classes: [] }, 'classes'],
      [{ classes: 'social.post' }, 'classes'],
      [{ classes: ['social.unknown'] }, 'classes'],
      [{ classes: ['social.post', 'social.post'] }, 'classes'],
      [{ ceiling: undefined }, 'ceiling'],
      [{ ceiling: AUD(-1) }, 'ceiling'],
      [{ ceiling: { amountMinor: 1.5, currency: 'AUD' } }, 'ceiling'],
      [{ ceiling: { amountMinor: 10, currency: 'aud' } }, 'ceiling'],
      [{ ceiling: { amountMinor: 10, currency: 'AUD', extra: 1 } }, 'ceiling'],
      [{ refuses: true }, 'ceiling'],
      [{ refuses: 'yes' }, 'refuses'],
      [{ expiresAt: undefined }, 'expiresAt'],
      [{ expiresAt: 'next week' }, 'expiresAt'],
      [{ expiresAt: new Date(Date.now() - 60_000).toISOString() }, 'expiresAt'],
      [{ label: '   ' }, 'label'],
      [{ label: `a${String.fromCodePoint(0)}b` }, 'label'],
      [{ label: 'x'.repeat(501) }, 'label'],
    ];
    for (const [body, field] of cases) {
      // eslint-disable-next-line no-await-in-loop -- one malformed body at a time
      const answer = await file(admin, body);
      expect([answer.status, answer.body['code']]).toStrictEqual([422, 'FIELD_VALUE_INVALID']);
      expect(JSON.stringify(answer.body)).toContain(field);
    }
    const unknownClient = await file(admin, { clientId: randomUUID() });
    expect(unknownClient.status).toBe(404);
    expect(await mandateRows()).toBe(before);
  });

  it('MP-14-10a core checks class, scope, ceiling, expiry and revocation at the effect', async () => {
    const filed = await file(admin, {
      classes: ['report.*'],
      ceiling: AUD(10_000),
      label: 'Reports for A up to a hundred dollars',
    });
    expect(filed.status).toBe(200);
    const mandateId = String(detail(filed)['mandateId']);
    const at = new Date();
    const ask = async (question: Parameters<typeof verdict>[0]) =>
      await verdict({ at, ...question });
    expect(await ask({})).toStrictEqual({ covered: true, mandateId });
    expect(await ask({ valueMinor: 10_000 })).toStrictEqual({ covered: true, mandateId });
    expect(await ask({ valueMinor: 10_001 })).toStrictEqual({
      covered: false,
      reason: 'over-ceiling',
      mandateId,
    });
    expect(await ask({ currency: 'USD' })).toMatchObject({
      covered: false,
      reason: 'over-ceiling',
    });
    expect(await ask({ actionClass: 'social.post' })).toStrictEqual({
      covered: false,
      reason: 'none',
    });
    expect(await ask({ clientId: clientB })).toStrictEqual({ covered: false, reason: 'none' });
    expect(await ask({ at: new Date(Date.now() + 31 * 86_400_000) })).toStrictEqual({
      covered: false,
      reason: 'expired',
      mandateId,
    });
    // Another business asking about the same client and class sees nothing.
    const foreign = await verdict({ valueMinor: 1, at }, bravo);
    expect(foreign).toStrictEqual({ covered: false, reason: 'none' });
    expect((await as(admin, 'mandate.revoke', { mandateId })).status).toBe(200);
    expect(await ask({})).toStrictEqual({ covered: false, reason: 'none' });
  });

  it('MP-14-10a core: a live matching refusal wins over an approval at the effect', async () => {
    const approval = await file(admin, {
      classes: ['billing.invoice'],
      ceiling: AUD(100_000),
      label: 'Invoices for A up to a thousand dollars',
    });
    const refusal = await file(admin, {
      classes: ['billing.*'],
      refuses: true,
      ceiling: null,
      label: 'No billing runs on its own for A',
    });
    const refusalId = String(detail(refusal)['mandateId']);
    const question = { actionClass: 'billing.invoice', valueMinor: 1 };
    expect(await verdict(question)).toStrictEqual({
      covered: false,
      reason: 'refused',
      mandateId: refusalId,
    });
    expect((await as(admin, 'mandate.revoke', { mandateId: refusalId })).status).toBe(200);
    const approvalId = String(detail(approval)['mandateId']);
    expect(await verdict(question)).toStrictEqual({ covered: true, mandateId: approvalId });
    expect((await as(admin, 'mandate.revoke', { mandateId: approvalId })).status).toBe(200);
  });

  it('MP-14-10a revoking stops pre-approval at once, and an effect already past its check is not undone', async () => {
    const filed = await file(admin, { classes: ['email.send'], label: 'Email for A' });
    const mandateId = String(detail(filed)['mandateId']);
    let revokeDone = false;
    let revoke: Promise<Answer> | undefined;
    const effect = await controls.fixture.db.app.withBusiness(alpha, async (tx) => {
      const checked = await standingMandateVerdict(tx, {
        clientId: clientA,
        actionClass: 'email.send',
        valueMinor: 1,
        currency: 'AUD',
        at: new Date(),
      });
      revoke = as(admin, 'mandate.revoke', { mandateId }).then((answer) => {
        revokeDone = true;
        return answer;
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 400);
      });
      // The revoke waits on the share lock this effect holds.
      expect(revokeDone).toBe(false);
      return checked;
    });
    expect(effect).toStrictEqual({ covered: true, mandateId });
    expect((await revoke)?.status).toBe(200);
    const after = await verdict({ actionClass: 'email.send', valueMinor: 1 });
    expect(after).toStrictEqual({ covered: false, reason: 'none' });
  });

  it('MP-14-10a every change is recorded and the audited ones join the audit chain', async () => {
    const filed = await file(admin, { label: 'Audit me' });
    const mandateId = String(detail(filed)['mandateId']);
    await as(admin, 'mandate.revoke', { mandateId });
    const promoted = await as(admin, 'graduation.promote', {
      classId: cls['aPost'],
      ceiling: AUD(500),
      expiresAt: inDays(2),
    });
    expect(promoted.status).toBe(200);
    expect((await as(admin, 'graduation.demote', { classId: cls['aPost'] })).status).toBe(200);
    for (const command of [
      'mandate.file',
      'mandate.revoke',
      'graduation.promote',
      'graduation.demote',
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one command at a time
      const events = await controls.fixture.db.admin.execute<{ readonly hash: string }>(
        `select hash from public.audit_events
          where actor_id = $1 and command = $2 and outcome = 'applied'`,
        [admin.actorId, command],
      );
      expect(events.length, command).toBeGreaterThan(0);
      for (const event of events) expect(event.hash).toMatch(/^[0-9a-f]{64}$/u);
    }
    const rows = await controls.fixture.db.admin.execute<{
      readonly authored_by_actor_id: string;
      readonly label: string;
      readonly revoked: boolean;
    }>(
      `select authored_by_actor_id, label, revoked_at is not null as revoked
         from public.standing_mandates where id = $1`,
      [mandateId],
    );
    expect(rows[0]).toStrictEqual({
      authored_by_actor_id: admin.actorId,
      label: 'Audit me',
      revoked: true,
    });
  });

  it('MP-14-10a the read and the scope bar add no audit event beyond the read operation row', async () => {
    const count = async (): Promise<number> =>
      await controls.count(`select count(*) as n from public.audit_events where actor_id = $1`, [
        reader.actorId,
      ]);
    const before = await count();
    const mandatesBefore = await mandateRows();
    await region(reader);
    expect(await count()).toBe(before + 1);
    const last = await controls.fixture.db.admin.execute<{ readonly command: string }>(
      `select command from public.audit_events where actor_id = $1 order by seq desc limit 1`,
      [reader.actorId],
    );
    expect(last[0]?.command).toBe('connection.graduation');
    expect(await mandateRows()).toBe(mandatesBefore);
  });

  it('MP-14-10a refusal mandate:manage: read, write and client-scoped holders change nothing', async () => {
    const filed = await file(admin, { label: 'Held for the refusal case' });
    const mandateId = String(detail(filed)['mandateId']);
    const before = await mandateRows();
    const live = await liveMandates();
    for (const who of [reader, clientManager, plain]) {
      for (const [name, body] of [
        [
          'mandate.file',
          {
            clientId: clientA,
            classes: ['social.post'],
            ceiling: AUD(1),
            expiresAt: inDays(1),
            label: 'x',
          },
        ],
        ['mandate.revoke', { mandateId }],
        ['graduation.promote', { classId: cls['aPost'], ceiling: AUD(1), expiresAt: inDays(1) }],
        ['graduation.demote', { classId: cls['aPost'] }],
      ] as const) {
        // eslint-disable-next-line no-await-in-loop -- one caller and command at a time
        const answer = await as(who, name, body);
        expect([answer.status, answer.body['code']], `${name}`).toStrictEqual([
          403,
          'SCOPE_NOT_GRANTED',
        ]);
      }
    }
    expect([await mandateRows(), await liveMandates()]).toStrictEqual([before, live]);
    expect((await as(admin, 'mandate.revoke', { mandateId })).status).toBe(200);
  });

  it('MP-14-10a refusal connection:read: a member without it is refused the region and shown nothing', async () => {
    const answer = await as(plain, 'connection.graduation', {});
    expect(answer.status).toBe(403);
    expect(answer.body['code']).toBe('SCOPE_NOT_GRANTED');
    expect(answer.body['rows']).toBeUndefined();
  });

  it('MP-14-10a isolation: an agent under a live delegation reads none of it and changes nothing', async () => {
    const task = await controls.createTask('agent crossing');
    const proposal = await controls.propose(task.id, task.revision);
    const picked = await controls.pickup(await controls.approve(proposal));
    const credential = String(picked['credential']);
    const before = await mandateRows();
    for (const [name, body] of [
      ['connection.graduation', {}],
      [
        'mandate.file',
        {
          clientId: clientA,
          classes: ['social.post'],
          ceiling: AUD(1),
          expiresAt: inDays(1),
          label: 'x',
        },
      ],
      ['graduation.promote', { classId: cls['aPost'], ceiling: AUD(1), expiresAt: inDays(1) }],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one crossing at a time
      const answer = await controls.asAgent(name, body, credential);
      answers.push(answer);
      expect(answer.status).toBe(403);
      expect(String(answer.body['code'])).toMatch(/^(DELEGATION_|AUTH_)/u);
      expect(answer.body['rows']).toBeUndefined();
    }
    expect(await mandateRows()).toBe(before);
  });

  it('MP-14-10a isolation: another business never sees, counts or changes these mandates', async () => {
    const ours = await file(admin, { label: `Ours ${RECORD_CANARY}` });
    const mandateId = String(detail(ours)['mandateId']);
    const theirs = await region(bravoAdmin, 'bravo');
    expect(theirs.rows.map((one) => one.id)).toStrictEqual([cls['bravoPost']]);
    expect(theirs.mandates).toStrictEqual([]);
    const text = JSON.stringify(theirs);
    for (const mine of [clientA, clientB, mandateId, RECORD_CANARY])
      expect(text).not.toContain(mine);

    const before = await liveMandates();
    const revoke = await as(bravoAdmin, 'mandate.revoke', { mandateId }, 'bravo');
    const promote = await as(
      bravoAdmin,
      'graduation.promote',
      { classId: cls['aPost'], ceiling: AUD(1), expiresAt: inDays(1) },
      'bravo',
    );
    const onOurClient = await file(bravoAdmin, {}, 'bravo');
    const fabricated = await as(bravoAdmin, 'mandate.revoke', { mandateId: randomUUID() }, 'bravo');
    const malformed = await as(bravoAdmin, 'mandate.revoke', { mandateId: 'not-a-uuid' }, 'bravo');
    for (const answer of [revoke, promote, onOurClient]) {
      expect([answer.status, answer.body['code']]).toStrictEqual([404, 'NOT_FOUND']);
    }
    for (const answer of [fabricated, malformed]) expect(answer.body).toStrictEqual(revoke.body);
    expect(await liveMandates()).toBe(before);
    expect(JSON.stringify(await region(admin))).not.toContain(BRAVO_CANARY);
    expect((await as(admin, 'mandate.revoke', { mandateId })).status).toBe(200);
  });

  it('MP-14-10a isolation: a client-scoped reader sees that client only, in rows, mandates and the client list', async () => {
    const onB = await file(admin, { clientId: clientB, label: `For B ${RECORD_CANARY}` });
    expect(onB.status).toBe(200);
    const mandateB = String(detail(onB)['mandateId']);
    const result = await region(clientManager);
    expect(result.clients.map((one) => one.id)).toStrictEqual([clientA]);
    expect(new Set(result.rows.map((one) => one.clientId))).toStrictEqual(new Set([clientA]));
    expect(result.mandates.every((one) => one.clientId === clientA)).toBe(true);
    const text = JSON.stringify(result);
    for (const theirs of [clientB, mandateB, RECORD_CANARY]) expect(text).not.toContain(theirs);
    const revoking = await as(clientManager, 'mandate.revoke', { mandateId: mandateB });
    expect(revoking.status).toBe(403);
    expect(JSON.stringify(revoking.body)).not.toContain(RECORD_CANARY);
    expect((await as(admin, 'mandate.revoke', { mandateId: mandateB })).status).toBe(200);
  });

  it('MP-14-10a a stale revision is refused and changes nothing', async () => {
    const filed = await file(admin, { label: 'Stale case' });
    const mandateId = String(detail(filed)['mandateId']);
    const live = await liveMandates();
    const stale = await as(admin, 'mandate.revoke', { mandateId, expectedRevision: 9 });
    expect([stale.status, stale.body['code']]).toStrictEqual([409, 'VERSION_STALE']);
    const promote = await as(admin, 'graduation.promote', {
      classId: cls['aPost'],
      ceiling: AUD(1),
      expiresAt: inDays(1),
      expectedRevision: 999,
    });
    expect([promote.status, promote.body['code']]).toStrictEqual([409, 'VERSION_STALE']);
    const bad = await as(admin, 'mandate.revoke', { mandateId, expectedRevision: 'one' });
    expect([bad.status, bad.body['code']]).toStrictEqual([422, 'FIELD_VALUE_INVALID']);
    expect(await liveMandates()).toBe(live);
    expect((await as(admin, 'mandate.revoke', { mandateId })).status).toBe(200);
    const again = await as(admin, 'mandate.revoke', { mandateId });
    expect([again.status, again.body['code']]).toStrictEqual([409, 'TRANSITION_NOT_PERMITTED']);
  });

  it('MP-14-10a two promotes at once make one standing mandate', async () => {
    const before = await liveMandates();
    const body = { classId: cls['bPost'], ceiling: AUD(700), expiresAt: inDays(5) };
    const [one, two] = await Promise.all([
      as(admin, 'graduation.promote', body),
      as(admin, 'graduation.promote', body),
    ]);
    expect([one.status, two.status].toSorted()).toStrictEqual([200, 409]);
    expect(await liveMandates()).toBe(before + 1);
    expect((await as(admin, 'graduation.demote', { classId: cls['bPost'] })).status).toBe(200);
  });

  it('MP-14-10a two revokes at once revoke once', async () => {
    const filed = await file(admin, { label: 'Race revoke' });
    const mandateId = String(detail(filed)['mandateId']);
    const [one, two] = await Promise.all([
      as(admin, 'mandate.revoke', { mandateId }),
      as(admin, 'mandate.revoke', { mandateId }),
    ]);
    expect([one.status, two.status].toSorted()).toStrictEqual([200, 409]);
    const rows = await controls.fixture.db.admin.execute<{ readonly revision: string }>(
      `select revision from public.standing_mandates where id = $1`,
      [mandateId],
    );
    expect(rows[0]?.revision).toBe('2');
  });

  it('MP-14-10a parity: the region is connection:read and every change mandate:manage, person only', () => {
    const readRow = COMMAND_SURFACE.find((one) => one.name === 'connection.graduation');
    expect([readRow?.collection, readRow?.action, readRow?.agent]).toStrictEqual([
      'connection',
      'read',
      'never',
    ]);
    for (const name of [
      'mandate.file',
      'mandate.revoke',
      'graduation.promote',
      'graduation.demote',
    ]) {
      const row = COMMAND_SURFACE.find((one) => one.name === name);
      expect([row?.collection, row?.action, row?.agent, row?.authorisedOn], name).toStrictEqual([
        'mandate',
        'manage',
        'never',
        'business',
      ]);
    }
  });
});
