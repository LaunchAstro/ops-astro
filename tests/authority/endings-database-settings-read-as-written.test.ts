// SPDX-License-Identifier: AGPL-3.0-only
//
// SOLOW-D D3 (Sol OW-070.1): the endings loop refuses a database setting that
// postgres.js would not read as written, by the setting's name alone. Its own
// parse takes the host after the first `@`, decodes it and splits it on
// commas, so a raw `@` or `,` in a password, or a percent-encoded comma, could
// put part of the password into a host name; the URL parser can also throw
// with the string. Each case plants a password marker and checks it never
// leaves in the answer.

import { describe, expect, it } from 'vitest';
import { endingsSettings } from '../../apps/endings/pass.ts';

const CANARY = 'SOLOW-D3-PASSWORD-CANARY';

const settings = {
  DATABASE_URL: 'postgres://app:solow-d3-pw@127.0.0.1:5432/ops',
  DATABASE_ADMIN_URL: 'postgresql://owner:solow-d3-pw@example.test:6543/ops?sslmode=require',
  GOTRUE_URL: 'https://abc.supabase.co/auth/v1',
  SUPABASE_SERVICE_KEY: 'solow-d3-service-key',
};

const hostile: readonly (readonly [string, string])[] = [
  ['a port that is not a number', `postgres://owner:${CANARY}@127.0.0.1:invalid/ops`],
  ['a raw @ in the password', `postgres://owner:${CANARY}@x@127.0.0.1:5432/ops`],
  ['a raw comma in the password', `postgres://owner:${CANARY},x@127.0.0.1:5432/ops`],
  ['a raw @ then a raw comma', `postgres://owner:a@${CANARY},b@127.0.0.1:5432/ops`],
  ['a raw @ then a percent-encoded comma', `postgres://owner:a@${CANARY}%2Cb@127.0.0.1/ops`],
  ['a host list', `postgres://owner:${CANARY}@10.0.0.1:5432,10.0.0.2:5432/ops`],
  ['a percent-encoded comma in the host', `postgres://owner:${CANARY}@db%2Cother/ops`],
  ['a # in the password', `postgres://owner:12#${CANARY}@127.0.0.1/ops`],
  ['a malformed percent escape', `postgres://owner:${CANARY}@db%zz/ops`],
  ['another scheme', `mysql://owner:${CANARY}@127.0.0.1/ops`],
  ['no URL at all', `owner:${CANARY}`],
];

describe('the endings loop database settings', () => {
  it('well-formed settings pass, a percent-encoded comma in the password included', () => {
    expect(endingsSettings(settings)).toMatchObject({ ok: true });
    const encoded = 'postgres://owner:pa%2Css%40word@127.0.0.1:5432/ops';
    expect(endingsSettings({ ...settings, DATABASE_ADMIN_URL: encoded })).toMatchObject({
      ok: true,
    });
  });

  for (const name of ['DATABASE_URL', 'DATABASE_ADMIN_URL'] as const) {
    it(`${name} that postgres.js would not read as written is refused by name only`, () => {
      for (const [label, value] of hostile) {
        const answer = endingsSettings({ ...settings, [name]: value });
        expect(answer, label).toMatchObject({ ok: false });
        expect(JSON.stringify(answer), label).toContain(name);
        expect(JSON.stringify(answer), label).not.toContain(CANARY);
      }
    });
  }
});
