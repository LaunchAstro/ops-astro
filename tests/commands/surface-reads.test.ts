// SPDX-License-Identifier: AGPL-3.0-only
//
// The two reads this lane adds, and the refusal every read now makes.
//
// `settings.read` projects the business facts `business_settings` holds, which
// four landed contracts name and no surface served. `session.capabilities`
// answers "what may I do here" from the live grant model rather than from a
// role name a client guessed at. Both are audited like every other read (I13),
// with a null subject, because neither is about one record.
//
// The third group is D06 on the read half. `prepareCommand` refuses a command
// payload that names a fact the server owns; a read payload carrying the same
// key was silently ignored, which is the weaker of the two answers the ledger
// rules out. The cases below require the refusal, require the offending keys
// to be named, and require the attempted *values* to be in the audit row and
// absent from the response.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { readAuditEvents } from '../../packages/core-records/src/commands/audit.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import type { ReadRequest } from '../../packages/core-records/src/reads/requests.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('surface reads: DATABASE_URL is unset, so nothing below ran.');
}

type Command = Parameters<typeof executeCommand>[4];

describe.skipIf(serverUrl === undefined)('the reads this lane adds', () => {
  let db: FreshDatabase;
  let alpha: string;
  /** Reads settings, writes settings, reads tasks. The positive control. */
  let mia: Member;
  /** A real member of alpha holding no grant at all. */
  let noah: Member;

  const read = async (request: ReadRequest, who: Member = mia) =>
    await executeRead(db.app, alpha, who.presented, request);

  const auditFor = async (command: string) =>
    await db.app.withBusiness(alpha, async (tx) => {
      const all = await readAuditEvents(tx);
      return all.filter((event) => event.command === command);
    });

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'l3' });
    alpha = await insertBusiness(db.app, 'alpha');
    await installSpine(db.app, alpha);
    await db.app.withBusiness(alpha, async (tx) => {
      await installBusinessSettings(tx);
    });
    mia = await enrol(db.app, alpha, 'mia');
    noah = await enrol(db.app, alpha, 'noah');
    await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, mia, 'read');
      await grantTo(tx, mia, 'read', { kind: 'business', id: null }, false, 'settings');
      await grantTo(tx, mia, 'manage', { kind: 'business', id: null }, false, 'settings');
    });
  }, 60_000);

  afterAll(async () => await db?.drop());

  describe('settings.read', () => {
    it('projects every setting with its value, type, time and author', async () => {
      const result = await read({ read: 'settings.read' });
      expect('settings' in result).toBe(true);
      if (!('settings' in result)) return;
      expect(result.settings.map((setting) => setting.key)).toStrictEqual([
        'client_sign_off_required',
        'conversation_window_days',
        'four_eyes_threshold',
        'retention_window_days',
      ]);
      const band = result.settings.find((setting) => setting.key === 'four_eyes_threshold');
      expect(band?.value).toBe(500);
      expect(band?.valueType).toBe('numeric');
      // Never written through a command yet, so nobody owns the last change.
      expect(band?.updatedByActorId).toBeNull();
      expect(typeof band?.updatedAt).toBe('string');
      // The revision is projected, because 0020 gave the row one and a write
      // names it: a caller reads this number and sends it back as
      // `expectedRevision`, and a projection that dropped it would leave the
      // caller nothing to say which value it was replacing.
      expect(typeof band?.revision).toBe('number');
    });

    it('names the actor a settings command wrote through', async () => {
      const written = await executeCommand(db.app, alpha, mia.presented, 'api', {
        command: 'settings.set_four_eyes_threshold',
        operationId: `band-${randomUUID()}`,
        value: 750,
      } as unknown as Command);
      expect(isCommandRefusal(written)).toBe(false);

      const result = await read({ read: 'settings.read' });
      if (!('settings' in result)) throw new Error('settings.read refused');
      const band = result.settings.find((setting) => setting.key === 'four_eyes_threshold');
      expect(band?.value).toBe(750);
      expect(band?.updatedByActorId).toBe(mia.actorId);
    });

    it('refuses a member with no grant, and audits both answers with a null subject', async () => {
      const denied = await read({ read: 'settings.read' }, noah);
      expect(isCommandRefusal(denied) ? denied.code : '').toBe('SCOPE_NOT_GRANTED');

      const events = await auditFor('settings.read');
      expect(events.length).toBeGreaterThanOrEqual(2);
      for (const event of events) {
        expect(event.operation_id).toBeNull();
        expect(event.subject_record_id).toBeNull();
      }
      expect(events.some((event) => event.outcome === 'applied')).toBe(true);
      const refused = events.find((event) => event.outcome === 'refused');
      expect(refused?.refusal_code).toBe('SCOPE_NOT_GRANTED');
    });
  });

  describe('session.capabilities', () => {
    it('answers the caller’s own live grants, the person and the business', async () => {
      const result = await read({ read: 'session.capabilities' });
      if (!('grants' in result)) throw new Error('session.capabilities refused');
      expect(result.personId).toBe(mia.personId);
      expect(result.businessKey).toBe('alpha');
      expect(
        result.grants.map((grant) => `${grant.collection}:${grant.action}`).toSorted(),
      ).toStrictEqual(['settings:manage', 'settings:read', 'task:read']);
    });

    it('refuses a member holding no grant, rather than answering an empty list', async () => {
      // Minimum contract 8.2 case 3 (I05): denied is never empty.
      const result = await read({ read: 'session.capabilities' }, noah);
      expect(isCommandRefusal(result) ? result.code : 'answered').toBe('SCOPE_NOT_GRANTED');
      expect('grants' in result).toBe(false);
      // Mia's pairs are hers. Nothing in this answer is anybody else's.
      expect(JSON.stringify(result).includes(mia.personId)).toBe(false);
    });

    it('follows a revocation, because the grants are read and not remembered', async () => {
      const before = await read({ read: 'session.capabilities' });
      if (!('grants' in before)) throw new Error('refused');
      expect(before.grants.some((grant) => grant.action === 'manage')).toBe(true);

      await db.app.withBusiness(alpha, async (tx) => {
        await tx.query(
          `update public.grants set revoked_at = now()
            where business_id = $1 and subject_id = $2 and collection = 'settings'
              and action = 'manage'`,
          [tx.businessId, mia.personId],
        );
      });

      const after = await read({ read: 'session.capabilities' });
      if (!('grants' in after)) throw new Error('refused');
      expect(after.grants.some((grant) => grant.action === 'manage')).toBe(false);
      expect(after.grants.some((grant) => grant.action === 'read')).toBe(true);

      // Put it back: the later cases read settings through it.
      await db.app.withBusiness(alpha, async (tx) => {
        await grantTo(tx, mia, 'manage', { kind: 'business', id: null }, false, 'settings');
      });
    });

    it('is audited like every other read, with a null subject', async () => {
      const events = await auditFor('session.capabilities');
      expect(events.length).toBeGreaterThanOrEqual(1);
      for (const event of events) {
        expect(event.operation_id).toBeNull();
        expect(event.subject_record_id).toBeNull();
      }
      // Answered and refused alike: noah's refusal is audited too (I13).
      expect(new Set(events.map((event) => event.outcome))).toStrictEqual(
        new Set(['applied', 'refused']),
      );
    });
  });

  describe('a read payload naming a fact the server owns (D06)', () => {
    const SYSTEM_FIELDS = {
      actor_id: randomUUID(),
      business_id: randomUUID(),
      updated_by_actor_id: randomUUID(),
    };

    it('refuses instead of ignoring, naming the keys and not their values', async () => {
      const result = await read({
        read: 'settings.read',
        ...SYSTEM_FIELDS,
      } as unknown as ReadRequest);
      expect(isCommandRefusal(result) ? result.code : '').toBe('FIELD_NOT_WRITABLE');
      if (!isCommandRefusal(result)) return;
      expect([...result.names].toSorted()).toStrictEqual([
        'actor_id',
        'business_id',
        'updated_by_actor_id',
      ]);
      // The values are the caller's own claim and they stay out of the answer.
      const answer = JSON.stringify(result);
      for (const value of Object.values(SYSTEM_FIELDS)) {
        expect(answer.includes(value)).toBe(false);
      }
    });

    it('puts the attempted values in the audit row and nowhere else', async () => {
      const spoofed = randomUUID();
      const result = await read({
        read: 'task.board',
        board: null,
        actor_id: spoofed,
      } as unknown as ReadRequest);
      expect(isCommandRefusal(result) ? result.code : '').toBe('FIELD_NOT_WRITABLE');

      const events = await auditFor('task.board');
      const refused = events.filter((event) => event.outcome === 'refused');
      expect(refused).toHaveLength(1);
      expect(refused[0]?.refusal_code).toBe('FIELD_NOT_WRITABLE');
      expect(refused[0]?.attempted).toStrictEqual({ actor_id: spoofed });
      expect(refused[0]?.subject_record_id).toBeNull();
    });

    it('leaves the ordinary read working, so the rule is not “refuse everything”', async () => {
      const result = await read({ read: 'task.board', board: null });
      expect('tasks' in result).toBe(true);
    });
  });
});
