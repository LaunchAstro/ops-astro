// SPDX-License-Identifier: AGPL-3.0-only
//
// FR1-JSONB continuation 2: can a settings write carry NUL or an unpaired
// surrogate into `business_settings.value` (jsonb) and fault?
//
// It cannot. Both settings commands narrow the value to a number, a boolean
// or null before the writer runs (`commands/settings-write.ts`), and the key
// each writes is the command's own, never the caller's. So a string, an
// object or an array holding either code unit is refused `FIELD_VALUE_INVALID`
// naming the operand `value` (API.md, operand refusals), with its refused
// audit row, and the row is untouched. A caller-named extra key holding them
// is refused and kept as the first branch arranged. A real write still applies.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from './fixture.ts';
import { grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { pathOf, type CommandName } from '../../packages/core-records/src/commands/surface.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

const NUL = String.fromCodePoint(0);
const LONE = String.fromCodePoint(0xd800);

const COMMANDS: readonly (readonly [CommandName, string])[] = [
  ['settings.set_four_eyes_threshold', 'four_eyes_threshold'],
  ['settings.set_client_sign_off', 'client_sign_off_required'],
];

const VALUES: readonly (readonly [string, unknown])[] = [
  ['a string holding NUL', `5${NUL}00`],
  ['a string holding an unpaired surrogate', `5${LONE}`],
  ['an object whose key holds NUL', { [`k${NUL}`]: 1 }],
  ['an object whose value holds an unpaired surrogate', { k: LONE }],
  ['an array holding both', [NUL, LONE]],
];

describe.skipIf(serverUrl === undefined)('FR1-JSONB: settings values jsonb cannot hold', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let token: string;

  const call = async (name: CommandName, body: Record<string, unknown>): Promise<Answer> =>
    await post(api, `/api/b/${BUSINESS_KEY}${pathOf(name)}`, body, authorised(token));

  const row = async (key: string) => {
    const rows = await fixture.db.admin.execute<{
      readonly value: string;
      readonly revision: string;
    }>(
      `select value::text as value, revision::text as revision from public.business_settings
        where business_id = $1 and key = $2`,
      [fixture.business, key],
    );
    return { ...rows[0] };
  };

  const audit = async (operationId: string) =>
    (
      await fixture.db.admin.execute<{
        readonly outcome: string;
        readonly refusal_code: string | null;
      }>(
        `select outcome, refusal_code from public.audit_events
          where business_id = $1 and operation_id = $2 order by seq`,
        [fixture.business, operationId],
      )
    ).map((each) => ({ outcome: each.outcome, refusal_code: each.refusal_code }));

  beforeAll(async () => {
    fixture = await createApiFixture('fr1_jsonb_settings');
    api = fixture.compose();
    token = await tokenFor(fixture.member.presented.subject);
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await grantTo(tx, fixture.member, 'read', WHOLE_BUSINESS, false, 'settings');
      await grantTo(tx, fixture.member, 'manage', WHOLE_BUSINESS, false, 'settings');
      await installBusinessSettings(tx);
    });
  }, 60_000);

  afterAll(async () => await fixture?.drop());

  for (const [name, key] of COMMANDS) {
    for (const [label, value] of VALUES) {
      it(`${name}: ${label} is refused FIELD_VALUE_INVALID naming value, kept, row untouched`, async () => {
        const before = await row(key);
        const operationId = randomUUID();
        const answer = await call(name, { operationId, value });
        expect(answer.status, JSON.stringify(answer.body)).toBe(422);
        expect(answer.body).toMatchObject({
          refused: true,
          code: 'FIELD_VALUE_INVALID',
          names: ['value'],
        });
        expect(await audit(operationId)).toStrictEqual([
          { outcome: 'refused', refusal_code: 'FIELD_VALUE_INVALID' },
        ]);
        expect(before.revision, 'the row the refusal must not touch').toBeDefined();
        expect(await row(key)).toStrictEqual(before);
      });
    }

    it(`${name}: an extra top-level key holding NUL is refused and kept, not a fault`, async () => {
      const operationId = randomUUID();
      const answer = await call(name, {
        operationId,
        value: name === 'settings.set_client_sign_off' ? true : 10,
        actor_id: `a${NUL}${LONE}`,
      });
      expect(answer.status, JSON.stringify(answer.body)).toBe(422);
      expect(answer.body).toMatchObject({ refused: true, code: 'FIELD_NOT_WRITABLE' });
      expect(await audit(operationId)).toStrictEqual([
        { outcome: 'refused', refusal_code: 'FIELD_NOT_WRITABLE' },
      ]);
    });
  }

  const applies = async (name: CommandName, key: string, value: unknown, stored: string) => {
    const before = await row(key);
    const answer = await call(name, { operationId: randomUUID(), value });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const after = await row(key);
    expect(after.value).toBe(stored);
    expect(Number(after.revision)).toBe(Number(before.revision) + 1);
  };

  it('positive control: real values still apply and move the revision', async () => {
    await applies('settings.set_four_eyes_threshold', 'four_eyes_threshold', 750, '750');
    await applies('settings.set_client_sign_off', 'client_sign_off_required', true, 'true');
  });
});
