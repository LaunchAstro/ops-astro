// SPDX-License-Identifier: AGPL-3.0-only
//
// The operator gate and a database address the driver reads differently from
// `URL` (D1 security review F1, after OW-065.1). postgres.js cuts a host list
// at its first comma and parses the address again, so an address whose list
// starts empty passes `URL.canParse` and then throws an error holding the cut
// address, password included. A real gated command, given such an address in
// either setting, refuses by the setting's name and never prints the password;
// so does an address with an empty host or a host list.

import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { serveTestKeySetApart, signBearer, TEST_ISSUER } from '../support/sign-in.ts';

const MARKER = 'd1-sec-f1-planted-password-marker';

const ADDRESSES: Record<string, string> = {
  'a host list that starts empty': `postgres://owner:${MARKER}@,db.example.com:5432/database`,
  'an empty host': `postgres://owner:${MARKER}@/database`,
  'a host list': `postgres://owner:${MARKER}@127.0.0.1,127.0.0.2/database`,
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
      expect(out).not.toContain(MARKER);
      expect(
        { status: result.status, refusedByName: out.includes(`REFUSED: ${setting} `) },
        out,
      ).toEqual({
        status: 1,
        refusedByName: true,
      });
    } finally {
      await keys.close();
    }
  },
);
