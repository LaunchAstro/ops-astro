// SPDX-License-Identifier: AGPL-3.0-only
//
// The operator gate and a database address the driver reads differently from
// `URL` (D1 security review F1, after OW-065.1). postgres.js cuts a host list
// at its first comma and parses the address again, so an address whose list
// starts empty passes `URL.canParse` and then throws an error holding the cut
// address, password included. A real gated command, given such an address in
// either setting, refuses by the setting's name and never prints the password;
// so does an address with an empty host or a host list.
//
// postgres.js also decodes the authority before it looks for a comma, and cuts
// at the first `@`, where `URL` cuts at the last (D1 security review R2). An
// encoded comma, or an `@` and a comma inside the password, would hand it a
// host list `URL` never shows, pieces of the password among the hosts; an
// address it cannot read at all throws. Each is refused by the setting's name.

import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { serveTestKeySetApart, signBearer, TEST_ISSUER } from '../support/sign-in.ts';

const MARKER = 'd1-sec-f1-planted-password-marker';

const ADDRESSES: Record<string, string> = {
  'a host list that starts empty': `postgres://owner:${MARKER}@,db.example.com:5432/database`,
  'an empty host': `postgres://owner:${MARKER}@/database`,
  'a host list': `postgres://owner:${MARKER}@127.0.0.1,127.0.0.2/database`,
  'an encoded comma in the host': `postgres://owner:${MARKER}@127.0.0.1%2C127.0.0.2:1/database`,
  'a lower-case encoded comma': `postgres://owner:${MARKER}@127.0.0.1%2c127.0.0.2:1/database`,
  'an encoded comma for the host': `postgres://owner:${MARKER}@%2C:1/database`,
  'an @ and a comma in the password': `postgres://owner:${MARKER}@127.0.0.3,127.0.0.4@127.0.0.1:1/database`,
  'an address the driver cannot read': `postgres://owner:${MARKER}@,h@127.0.0.1:1/database`,
};

const cases = Object.entries(ADDRESSES).flatMap(([shape, address]) =>
  ['DATABASE_ADMIN_URL', 'DATABASE_URL'].map((setting) => [shape, setting, address] as const),
);

it.each(cases)(
  '%s in %s is refused by name and never printed',
  async (_shape, setting, address) => {
    const keys = await serveTestKeySetApart();
    try {
      const token = await signBearer({
        sub: 'd1-sec-f1-person',
        aud: 'authenticated',
        iss: TEST_ISSUER,
        exp: Math.floor(Date.now() / 1000) + 600,
      });
      const result = spawnSync(process.execPath, ['scripts/ops/operator.mjs', 'prepare'], {
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          PATH: process.env['PATH'],
          OPS_ASTRO_TOKEN: token,
          OPS_ASTRO_BUSINESS: 'alpha',
          OPS_ASTRO_DEPLOYMENTS: '/unused-d1-sec-f1-records',
          GOTRUE_URL: TEST_ISSUER,
          SUPABASE_KEY_SET_URL: keys.url,
          DATABASE_ADMIN_URL: 'postgres://owner@127.0.0.1:1/unused',
          DATABASE_URL: 'postgres://runtime@127.0.0.1:1/unused',
          [setting]: address,
        },
      });
      const out = `${result.stdout}${result.stderr}`;
      // A failure names the outcome, never the password: the output goes in with it masked.
      expect(out.includes(MARKER), 'the planted password was printed').toBe(false);
      expect(
        { status: result.status, refusedByName: out.includes(`REFUSED: ${setting} `) },
        out.replaceAll(MARKER, '[planted password]'),
      ).toEqual({
        status: 1,
        refusedByName: true,
      });
    } finally {
      await keys.close();
    }
  },
);
