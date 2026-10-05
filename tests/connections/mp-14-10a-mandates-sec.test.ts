// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-14-10a, the security read's fixes (SEC-P05B-PR): a mandate's label is a
// closed grammar, an expiry year the column refuses is refused by name, and
// demote ends a promotion a refusal is holding. The audit subject (PR.4) is
// proved in `mp-14-10a-mandates.test.ts`. Same world (`mandates-world.ts`).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createClient } from '../../packages/core-records/src/index.ts';
import type { Answer } from '../api/fixture.ts';
import { AUD, buildMandatesWorld, detail, inDays, type MandatesWorld } from './mandates-world.ts';

const serverUrl = databaseUrlFromEnvironment();

const at = (code: number): string => String.fromCodePoint(code);

/** One label for each class of character the label grammar refuses. */
const REFUSED_LABELS: readonly [string, string][] = [
  ['ESC escape', `Posts ${at(0x1b)}[31mfine`],
  ['C0 tab', `Posts${at(0x09)}fine`],
  ['DEL', `Posts ${at(0x7f)} fine`],
  ['C1 NEL', `Posts ${at(0x85)} fine`],
  ['C1 CSI', `Posts ${at(0x9b)}31m fine`],
  ['line feed', `Posts fine${at(0x0a)}Revoked`],
  ['carriage return', `Posts fine${at(0x0d)}Revoked`],
  ['line separator', `Posts fine${at(0x2028)}Revoked`],
  ['paragraph separator', `Posts fine${at(0x2029)}Revoked`],
  ['bidi override RLO', `Refuse social.post for ${at(0x202e)}emcA`],
  ['bidi isolate RLI', `Refuse ${at(0x2067)}social.post${at(0x2069)}`],
  ['bidi mark LRM', `Posts${at(0x200e)} fine`],
  ['Arabic letter mark', `Posts${at(0x61c)} fine`],
  ['zero-width space', `Posts${at(0x200b)} fine`],
  ['word joiner', `Posts${at(0x2060)} fine`],
  ['byte order mark', `Posts${at(0xfeff)} fine`],
  ['soft hyphen', `Po${at(0xad)}sts fine`],
  ['interlinear annotation', `Posts${at(0xfff9)} fine`],
  ['nothing visible', at(0x200d)],
];

const PLAIN_LABEL = `Posts for Café Ōtautahi (über 5%, "quoted"; a/b & c's) 東京 Москва ${at(0x1f469)}${at(0x200d)}${at(0x1f4bb)}`;

const BAD_YEARS = [
  '0000-06-01T00:00:00.000Z',
  '-000001-01-01T00:00:00.000Z',
  '+010000-01-01T00:00:00.000Z',
];

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('MP-14-10a mandate commands, security fixes', () => {
  let w: MandatesWorld;

  const labelOfMandate = async (answer: Answer): Promise<string | undefined> =>
    (
      await w.controls.fixture.db.admin.execute<{ readonly label: string }>(
        'select label from public.standing_mandates where id = $1',
        [String(detail(answer)['mandateId'])],
      )
    )[0]?.label;

  const failedEvents = async (): Promise<number> =>
    await w.controls.count(
      `select count(*) as n from public.audit_events where outcome = 'failed'`,
      [],
    );

  const seedClass = async (client: string, actionClass: string, label: string): Promise<string> => {
    const id = randomUUID();
    await w.controls.fixture.db.admin.execute(
      `insert into public.graduation_classes
         (business_id, id, client_id, action_class, class_label, clearance, earned,
          never_why, approved, edited, rejected, since, note)
       values ($1, $2, $3, $4, $5, 'Draft', 'ready', null, 30, 1, 0, '2026-08-01', '')`,
      [w.alpha, id, client, actionClass, label],
    );
    return id;
  };

  beforeAll(async () => {
    w = await buildMandatesWorld('mp1410as');
  }, 120_000);

  afterAll(async () => {
    await w?.drop();
  });

  it('SEC-P05B-PR.1 a label holding a control, line break, bidi or invisible character is refused on label, nothing written', async () => {
    const before = await w.snapshot();
    for (const [name, label] of REFUSED_LABELS) {
      // eslint-disable-next-line no-await-in-loop -- one label at a time
      const answer = await w.file(w.admin, { label });
      expect([answer.status, answer.body['code']], name).toStrictEqual([
        422,
        'FIELD_VALUE_INVALID',
      ]);
      expect(JSON.stringify(answer.body), name).toContain('label');
    }
    expect(await w.snapshot()).toBe(before);
  });

  it('SEC-P05B-PR.1 a label with ordinary punctuation, non-Latin letters and a joined emoji still files as sent', async () => {
    const filed = await w.file(w.admin, { label: PLAIN_LABEL });
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);
    expect(await labelOfMandate(filed)).toBe(PLAIN_LABEL);
  });

  it('SEC-P05B-PR.1 a promote label never carries what the label guard refuses: such a name is shown by its identifier', async () => {
    const spoofed = await w.controls.fixture.db.app.withBusiness(w.alpha, async (tx) => {
      const made = await createClient(tx, `Client ${at(0x202e)}C`, w.admin.actorId);
      if (!made.ok) throw new Error('sec-p05b: the client was not made');
      return made.value;
    });
    const badClass = await seedClass(w.clientA, 'social.story', `Stories${at(0x0a)}${at(0x202e)}t`);
    const badClient = await seedClass(spoofed, 'social.post', 'Class social.post');
    const promote = async (classId: string) => {
      const promoted = await w.as(w.admin, 'graduation.promote', {
        classId,
        ceiling: AUD(100),
        expiresAt: inDays(3),
      });
      expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
      return await labelOfMandate(promoted);
    };
    expect(await promote(badClass)).toBe('Run social.story unattended for Client A');
    expect(await promote(badClient)).toBe(`Run Class social.post unattended for client ${spoofed}`);
  });

  it('SEC-P05B-PR.2 an expiry year outside 0001 to 9999 is refused on expiresAt, never a fault', async () => {
    const before = await w.snapshot();
    const failedBefore = await failedEvents();
    for (const expiresAt of BAD_YEARS) {
      // eslint-disable-next-line no-await-in-loop -- one expiry at a time
      const filed = await w.file(w.admin, { expiresAt });
      expect([filed.status, filed.body['code']], `file ${expiresAt}`).toStrictEqual([
        422,
        'FIELD_VALUE_INVALID',
      ]);
      expect(JSON.stringify(filed.body), expiresAt).toContain('expiresAt');
      // eslint-disable-next-line no-await-in-loop -- one expiry at a time
      const promoted = await w.as(w.admin, 'graduation.promote', {
        classId: w.cls['aShare'],
        ceiling: AUD(1),
        expiresAt,
      });
      expect([promoted.status, promoted.body['code']], `promote ${expiresAt}`).toStrictEqual([
        422,
        'FIELD_VALUE_INVALID',
      ]);
    }
    expect(await w.snapshot()).toBe(before);
    expect(await failedEvents()).toBe(failedBefore);
  });

  it('SEC-P05B-PR.5 demote ends a promotion a refusal is holding, so the class is ready, not promoted, when the refusal ends', async () => {
    const promoted = await w.as(w.admin, 'graduation.promote', {
      classId: w.cls['aLike'],
      ceiling: AUD(500),
      expiresAt: inDays(10),
    });
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
    const promotion = String(detail(promoted)['mandateId']);
    const refusal = await w.file(w.admin, {
      classes: ['social.like'],
      refuses: true,
      ceiling: undefined,
      label: 'Hold likes for A',
    });
    expect(refusal.status, JSON.stringify(refusal.body)).toBe(200);

    const demoted = await w.as(w.admin, 'graduation.demote', { classId: w.cls['aLike'] });
    expect(demoted.status, JSON.stringify(demoted.body)).toBe(200);
    expect(detail(demoted)).toMatchObject({ mandateId: promotion, state: 'held' });

    const ended = await w.as(w.admin, 'mandate.revoke', {
      mandateId: String(detail(refusal)['mandateId']),
    });
    expect(ended.status).toBe(200);
    const promoting = await w.controls.count(
      `select count(*) as n from public.standing_mandates
        where client_id = $1 and graduation_class = 'social.like' and revoked_at is null`,
      [w.clientA],
    );
    expect(promoting).toBe(0);
    // Ready, not promoted: a promote is permitted again (it is refused on any other state).
    const again = await w.as(w.admin, 'graduation.promote', {
      classId: w.cls['aLike'],
      ceiling: AUD(500),
      expiresAt: inDays(10),
    });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
  });
});
