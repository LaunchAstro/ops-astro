// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine } from '../commands/fixture.ts';
import { insertBusiness, insertLogin, insertMapping } from '../identity/fixture.ts';
import { tokenFor } from './fixture.ts';
import {
  ada,
  adaToken,
  auditCount,
  benToken,
  c,
  call,
  fixture,
  read,
  save,
  usePreferencesWorld,
} from './preferences-world.ts';

const KEY = 'tasks.pinned';
const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const most = Array.from(
  { length: 128 },
  (_, i) => `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
);

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'task pins in the caller preference store',
  // eslint-disable-next-line max-lines-per-function -- four HTTP cases share one isolated synthetic world
  () => {
    usePreferencesWorld('taskpins');

    it('persists, replaces and clears own pins; operation replay cannot restore an older set; saves remain unaudited', async () => {
      const before = await auditCount(ada.actorId);
      const body = { operationId: randomUUID(), preference: KEY, value: [FIRST] };
      const first = await call('preference.save', body, adaToken);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body['detail']).toEqual({ preference: KEY });
      expect((await read(adaToken))[KEY]).toEqual([FIRST]);
      expect((await save(KEY, [SECOND], adaToken)).status).toBe(200);
      expect(await call('preference.save', body, adaToken)).toEqual(first);
      expect((await read(adaToken))[KEY]).toEqual([SECOND]);
      const rows = await fixture.db.admin.execute<{
        business_id: string;
        person_id: string;
        value: unknown;
      }>(
        'select business_id, person_id, value from public.person_preferences where business_id = $1 and person_id = $2 and key = $3',
        [fixture.business, ada.personId, KEY],
      );
      expect(rows).toEqual([
        { business_id: fixture.business, person_id: ada.personId, value: [SECOND] },
      ]);
      expect((await save(KEY, [], adaToken)).status).toBe(200);
      expect((await read(adaToken))[KEY]).toEqual([]);
      expect(await auditCount(ada.actorId)).toBe(before);
    });

    it('rejects malformed, duplicate, uppercase, oversize and caller selectors without changing the stored value', async () => {
      expect((await save(KEY, [FIRST], adaToken)).status).toBe(200);

      expect((await save(KEY, most, benToken)).status).toBe(200);
      expect((await read(benToken))[KEY]).toEqual(most);
      for (const value of [
        null,
        {},
        [FIRST, FIRST],
        ['not-an-id'],
        [3],
        ['ABCDEFAB-1111-4111-8111-111111111111'],
        [...most, FIRST],
      ]) {
        // eslint-disable-next-line no-await-in-loop -- assert each refusal before the next request
        const refused = await save(KEY, value, adaToken);
        expect(refused.status, JSON.stringify(value)).toBe(422);
        expect(refused.body['code']).toBe('FIELD_VALUE_INVALID');
      }
      for (const { selector, status, code, names } of [
        {
          selector: { personId: ada.personId },
          status: 422,
          code: 'FIELD_NOT_WRITABLE',
          names: ['personId'],
        },
        {
          selector: { businessId: fixture.business },
          status: 422,
          code: 'FIELD_NOT_WRITABLE',
          names: ['businessId'],
        },
        {
          selector: { businessKey: 'bravo' },
          status: 400,
          code: 'COMMAND_BODY_INVALID',
          names: [],
        },
      ]) {
        // eslint-disable-next-line no-await-in-loop -- each forbidden selector is independently refused
        const refused = await save(KEY, [], adaToken, selector);
        expect(refused.status, JSON.stringify(refused.body)).toBe(status);
        expect(refused.body['code']).toBe(code);
        expect(refused.body['names']).toEqual(names);
      }
      expect((await read(adaToken))[KEY]).toEqual([FIRST]);
      expect((await read(benToken))[KEY]).toEqual(most);
    });

    it('isolates different people and the same authenticated login across businesses', async () => {
      expect((await save(KEY, [FIRST], adaToken)).status).toBe(200);
      expect((await save(KEY, [SECOND], benToken)).status).toBe(200);
      expect((await read(adaToken))[KEY]).toEqual([FIRST]);
      expect((await read(benToken))[KEY]).toEqual([SECOND]);
      const bravo = await insertBusiness(fixture.db.app, 'bravo');
      await installSpine(fixture.db.app, bravo);
      const other = await enrol(fixture.db.app, bravo, 'Ada in Bravo');
      await fixture.db.app.withBusiness(bravo, async (tx) => {
        const login = await insertLogin(tx, ada.presented.subject);
        await insertMapping(tx, login, other.personId, other.actorId);
        await grantTo(tx, other, 'read');
      });
      expect((await read(adaToken, 'bravo'))[KEY]).toBeUndefined();
      const saved = await call(
        'preference.save',
        { operationId: randomUUID(), preference: KEY, value: [SECOND] },
        adaToken,
        { key: 'bravo' },
      );
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect((await read(adaToken, 'bravo'))[KEY]).toEqual([SECOND]);
      expect((await read(adaToken))[KEY]).toEqual([FIRST]);
    });

    it('a pin grants no task read access and returns no hidden name or identity', async () => {
      const hidden = await c.createTask('Synthetic task whose name must stay hidden');
      const bare = await enrol(
        fixture.db.app,
        fixture.business,
        'Pin caller with no record grants',
      );
      const token = await tokenFor(bare.presented.subject);
      const before = await call('task.read', { recordId: hidden.id }, token);
      expect(before.status).not.toBe(200);
      const saved = await save(KEY, [hidden.id], token);
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.body['detail']).toEqual({ preference: KEY });
      const after = await call('task.read', { recordId: hidden.id }, token);
      expect(after.status).toBe(before.status);
      expect(after.body['code']).toBe(before.body['code']);
      expect(JSON.stringify([saved.body, after.body])).not.toContain(
        'Synthetic task whose name must stay hidden',
      );
      expect(JSON.stringify(saved.body)).not.toContain(bare.personId);
      expect((await call('preference.read', {}, token)).body['code']).toBe('SCOPE_NOT_GRANTED');
    });
  },
);
