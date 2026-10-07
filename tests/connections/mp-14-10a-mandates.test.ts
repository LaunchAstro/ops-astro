// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-14-10a, the command half: filing, revoking, promoting and demoting
// standing mandates over HTTP against a real database. Each case is named
// after the acceptance line it proves (U39). The races and the isolation
// crossings are in `mp-14-10a-mandates-races.test.ts`, over the same world
// (`mandates-world.ts`).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { createClient } from '../../packages/core-records/src/index.ts';
import { AUD, buildMandatesWorld, detail, inDays, type MandatesWorld } from './mandates-world.ts';

const serverUrl = databaseUrlFromEnvironment();

const COMMANDS = ['mandate.file', 'mandate.revoke', 'graduation.promote', 'graduation.demote'];

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('MP-14-10a mandate commands', () => {
  let w: MandatesWorld;

  const audited = async (actorId: string, command: string, recordId: string): Promise<number> =>
    await w.controls.count(
      `select count(*) as n from public.audit_events
        where actor_id = $1 and command = $2 and outcome = 'applied' and subject_record_id = $3`,
      [actorId, command, recordId],
    );

  const mandateRow = async (id: string) =>
    (
      await w.controls.fixture.db.admin.execute<{
        readonly client_id: string;
        readonly classes: readonly string[];
        readonly ceiling_minor: string | null;
        readonly currency: string | null;
        readonly graduation_class: string | null;
        readonly label: string;
        readonly authored_by_actor_id: string;
        readonly revoked_by_actor_id: string | null;
        readonly revision: string;
      }>(
        `select client_id, classes, ceiling_minor::text, currency, graduation_class, label,
                authored_by_actor_id, revoked_by_actor_id, revision::text
           from public.standing_mandates where id = $1`,
        [id],
      )
    )[0];

  beforeAll(async () => {
    w = await buildMandatesWorld('mp1410ac');
  }, 120_000);

  afterAll(async () => {
    await w?.drop();
  });

  it('MP-14-10a owner check: choose a client, file an approval with a ceiling and expiry, then revoke it; both recorded and audited', async () => {
    const filed = await w.file(w.admin, {});
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);
    const mandateId = String(detail(filed)['mandateId']);
    expect(await mandateRow(mandateId)).toMatchObject({
      client_id: w.clientA,
      classes: ['social.post'],
      ceiling_minor: '50000',
      currency: 'AUD',
      authored_by_actor_id: w.admin.actorId,
      revoked_by_actor_id: null,
      revision: '1',
    });
    expect(await audited(w.admin.actorId, 'mandate.file', mandateId)).toBe(1);

    const revoked = await w.as(w.admin, 'mandate.revoke', { mandateId, expectedRevision: 1 });
    expect(revoked.status).toBe(200);
    expect(await mandateRow(mandateId)).toMatchObject({
      revoked_by_actor_id: w.admin.actorId,
      revision: '2',
    });
    expect(await audited(w.admin.actorId, 'mandate.revoke', mandateId)).toBe(1);
  });

  it('MP-14-10a promote writes the class standing mandate for that client and demote revokes it; promote is refused unless the class shows ready', async () => {
    const before = await w.mandateRows();
    for (const id of ['aBudget', 'aReport', 'aEmail', 'aInvoice']) {
      // eslint-disable-next-line no-await-in-loop -- one row at a time
      const answer = await w.as(w.admin, 'graduation.promote', {
        classId: w.cls[id],
        ceiling: AUD(1000),
        expiresAt: inDays(7),
      });
      expect([answer.status, answer.body['code']], id).toStrictEqual([
        409,
        'TRANSITION_NOT_PERMITTED',
      ]);
    }
    expect(await w.mandateRows()).toBe(before);
    const notPromoted = await w.as(w.admin, 'graduation.demote', { classId: w.cls['aReply'] });
    expect([notPromoted.status, notPromoted.body['code']]).toStrictEqual([
      409,
      'TRANSITION_NOT_PERMITTED',
    ]);

    const promoted = await w.as(w.admin, 'graduation.promote', {
      classId: w.cls['aReply'],
      ceiling: AUD(2000),
      expiresAt: inDays(14),
      expectedRevision: 1,
    });
    expect(promoted.status).toBe(200);
    const mandateId = String(detail(promoted)['mandateId']);
    expect(await mandateRow(mandateId)).toMatchObject({
      client_id: w.clientA,
      classes: ['social.reply'],
      graduation_class: 'social.reply',
      ceiling_minor: '2000',
      // The client's own name, read under the class's lock; the audit names the mandate (PR.4).
      label: 'Run Class social.reply unattended for Client A',
    });
    expect(await audited(w.admin.actorId, 'graduation.promote', mandateId)).toBe(1);

    const demoted = await w.as(w.admin, 'graduation.demote', {
      classId: w.cls['aReply'],
      expectedRevision: 2,
    });
    expect(demoted.status).toBe(200);
    expect(await mandateRow(mandateId)).toMatchObject({
      revoked_by_actor_id: w.admin.actorId,
      revision: '2',
    });
    expect(await audited(w.admin.actorId, 'graduation.demote', mandateId)).toBe(1);
  });

  it('MP-14-10a a client with no graduation rows takes a whole-account mandate, the one choice the region offers it', async () => {
    const bare = await w.controls.fixture.db.app.withBusiness(w.alpha, async (tx) => {
      const made = await createClient(tx, 'Client with no classes yet', w.admin.actorId);
      if (!made.ok) throw new Error('mp-14-10a: the client was not made');
      return made.value;
    });
    const refusal = { clientId: bare, classes: ['*'], refuses: true, ceiling: undefined };
    const filed = await w.file(w.admin, refusal);
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);
    const narrower = await w.file(w.admin, { ...refusal, classes: ['social.post'] });
    expect([narrower.status, narrower.body['code']]).toStrictEqual([422, 'FIELD_VALUE_INVALID']);
  });

  it('MP-14-10a nothing files until classes, client, ceiling and expiry are set, each from its list', async () => {
    const before = await w.snapshot();
    const cases: readonly [Record<string, unknown>, string][] = [
      [{ classes: undefined }, 'classes'],
      [{ classes: [] }, 'classes'],
      [{ classes: 'social.post' }, 'classes'],
      [{ classes: ['social.unknown'] }, 'classes'],
      [{ classes: ['Social.Post'] }, 'classes'],
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
      const answer = await w.file(w.admin, body);
      expect([answer.status, answer.body['code']], field).toStrictEqual([
        422,
        'FIELD_VALUE_INVALID',
      ]);
      expect(JSON.stringify(answer.body), field).toContain(field);
    }
    const noClient = await w.file(w.admin, { clientId: randomUUID() });
    expect([noClient.status, noClient.body['code']]).toStrictEqual([404, 'NOT_FOUND']);
    const surprise = await w.file(w.admin, { surprise: 'social.post' });
    expect(surprise.status).toBeGreaterThanOrEqual(400);
    expect(surprise.status).toBeLessThan(500);
    const promoteNoCeiling = await w.as(w.admin, 'graduation.promote', {
      classId: w.cls['aShare'],
      expiresAt: inDays(1),
    });
    expect([promoteNoCeiling.status, promoteNoCeiling.body['code']]).toStrictEqual([
      422,
      'FIELD_VALUE_INVALID',
    ]);
    expect(await w.snapshot()).toBe(before);
  });

  it('MP-14-10a refusal mandate:manage: connection:read only, a write grant, and a client-scoped holder on another client are refused, nothing written', async () => {
    const before = await w.snapshot();
    const bodies: readonly [string, Record<string, unknown>][] = [
      [
        'mandate.file',
        {
          clientId: w.clientB,
          classes: ['social.post'],
          ceiling: AUD(1),
          expiresAt: inDays(1),
          label: 'x',
        },
      ],
      ['mandate.revoke', { mandateId: w.seeded.alphaB }],
      ['graduation.promote', { classId: w.cls['bPost'], ceiling: AUD(1), expiresAt: inDays(1) }],
      ['graduation.demote', { classId: w.cls['bPost'] }],
    ];
    for (const who of [w.connReader, w.writer, w.clientManager]) {
      for (const [name, body] of bodies) {
        // eslint-disable-next-line no-await-in-loop -- one caller and command at a time
        const answer = await w.as(who, name, body);
        expect([answer.status, answer.body['code']], name).toStrictEqual([
          403,
          'SCOPE_NOT_GRANTED',
        ]);
        expect(JSON.stringify(answer.body)).not.toContain('record-canary');
      }
    }
    expect(await w.snapshot()).toBe(before);
  });

  it('MP-14-10a a stale revision is refused and changes nothing', async () => {
    const filed = await w.file(w.admin, { label: 'Stale case' });
    const mandateId = String(detail(filed)['mandateId']);
    const before = await w.snapshot();
    const stale = await w.as(w.admin, 'mandate.revoke', { mandateId, expectedRevision: 9 });
    expect([stale.status, stale.body['code']]).toStrictEqual([409, 'VERSION_STALE']);
    const promote = await w.as(w.admin, 'graduation.promote', {
      classId: w.cls['aShare'],
      ceiling: AUD(1),
      expiresAt: inDays(1),
      expectedRevision: 999,
    });
    expect([promote.status, promote.body['code']]).toStrictEqual([409, 'VERSION_STALE']);
    const bad = await w.as(w.admin, 'mandate.revoke', { mandateId, expectedRevision: 'one' });
    expect([bad.status, bad.body['code']]).toStrictEqual([422, 'FIELD_VALUE_INVALID']);
    expect(await w.snapshot()).toBe(before);
    expect((await w.as(w.admin, 'mandate.revoke', { mandateId })).status).toBe(200);
    const again = await w.as(w.admin, 'mandate.revoke', { mandateId });
    expect([again.status, again.body['code']]).toStrictEqual([409, 'TRANSITION_NOT_PERMITTED']);
  });

  it('MP-14-10a a stale sign-in is refused STEP_UP_REQUIRED (mandate:manage is in the money set) and changes nothing', async () => {
    const before = await w.snapshot();
    const bodies: readonly [string, Record<string, unknown>][] = [
      ['mandate.file', { clientId: w.clientA, classes: ['social.post'], ceiling: AUD(1) }],
      ['mandate.revoke', { mandateId: w.seeded.alphaB }],
      ['graduation.promote', { classId: w.cls['aShare'], ceiling: AUD(1), expiresAt: inDays(1) }],
      ['graduation.demote', { classId: w.cls['aShare'] }],
    ];
    for (const signIn of ['no-factor', 'stale-factor'] as const) {
      for (const [name, body] of bodies) {
        const full = name === 'mandate.file' ? { ...body, expiresAt: inDays(1), label: 'x' } : body;
        // eslint-disable-next-line no-await-in-loop -- one sign-in and command at a time
        const answer = await w.as(w.admin, name, full, 'alpha', signIn);
        expect([answer.status, answer.body['code']], `${signIn} ${name}`).toStrictEqual([
          403,
          'STEP_UP_REQUIRED',
        ]);
      }
    }
    expect(await w.snapshot()).toBe(before);
  });

  it('MP-14-10a SC3-F1: a stale sign-in refusal holds no operation, so the same one revokes once stepped up; a stored filing is withheld from a stale or ahead-of-clock factor, then released once', async () => {
    const mandateId = String(detail(await w.file(w.admin, {}))['mandateId']);
    const refused = { mandateId, expectedRevision: 1, operationId: randomUUID() };
    const first = await w.as(w.admin, 'mandate.revoke', refused, 'alpha', 'stale-factor');
    const again = await w.as(w.admin, 'mandate.revoke', refused, 'alpha', 'fresh');
    expect(await mandateRow(mandateId)).toMatchObject({ revoked_by_actor_id: w.admin.actorId });
    const filing = { operationId: randomUUID(), clientId: w.clientA, classes: ['social.post'] };
    const body = { ...filing, ceiling: AUD(50_000), expiresAt: inDays(30), label: 'Lost once' };
    const once = await w.as(w.admin, 'mandate.file', body);
    const count = await w.mandateRows();
    const stale = await w.as(w.admin, 'mandate.file', body, 'alpha', 'stale-factor');
    const ahead = await w.as(w.admin, 'mandate.file', body, 'alpha', 'ahead-factor');
    const released = await w.as(w.admin, 'mandate.file', body);
    const codes = [first, again, stale, ahead].map((one) => one.body['code'] ?? one.status);
    expect(codes).toStrictEqual(['STEP_UP_REQUIRED', 200, 'STEP_UP_REQUIRED', 'STEP_UP_REQUIRED']);
    const ids = [detail(once)['mandateId'], detail(released)['mandateId']];
    expect([once.status, ids[1]]).toStrictEqual([200, ids[0]]);
    expect(await w.mandateRows()).toBe(count);
  });

  it('MP-14-10a parity: every change is mandate:manage, person only', () => {
    for (const name of COMMANDS) {
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
