// SPDX-License-Identifier: AGPL-3.0-only
//
// The operator gate reads the business key as the lookup identity (0046) on
// DATABASE_ADMIN_URL. An admin login that may not take that identity, as
// hosted Supabase's was before 20261005063514, is the installation's fault,
// not the operator's: the gate names it and never answers that the operator
// is not a person of the business. A database the identity may not read
// (s0-3e-operating-business.test.ts, the redirected admin URL) still holds
// no business.

import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { requireOperatingOperator } from '../../scripts/ops/operator.ts';
import {
  environment,
  operatorOnlyHooks,
  serverUrl,
  subjects,
  token,
} from './operator-only.fixture.ts';
import { manager, marks } from './operator-only-commands.fixture.ts';
import type { OperatorOnlyState } from './operator-only.fixture.ts';

let state: OperatorOnlyState;
let name = '';

describe.skipIf(serverUrl === undefined)(
  'the operator gate on an admin login without the lookup identity',
  () => {
    operatorOnlyHooks((shared) => {
      state = shared;
    });

    afterAll(async () => {
      if (name === '') return;
      await state.db.admin.execute(`revoke connect on database "${state.db.name}" from "${name}"`);
      await state.db.admin.execute(`drop role if exists "${name}"`);
    });

    it('names an admin login refused the lookup identity instead of refusing the operator', async () => {
      // Shaped like hosted Supabase's admin login: ADMIN OPTION on the identity alone.
      name = `${state.db.name}_ad`;
      const password = randomBytes(18).toString('base64url');
      await state.db.admin.execute(
        `create role "${name}" login inherit nosuperuser createrole password '${password}'`,
      );
      await state.db.admin.execute(`grant connect on database "${state.db.name}" to "${name}"`);
      await state.db.admin.execute(
        `grant ops_astro_lookup to "${name}" with admin true, inherit false, set false`,
      );
      const shaped = new URL(serverUrl ?? '');
      shaped.pathname = `/${state.db.name}`;
      shaped.username = name;
      shaped.password = password;

      const env = environment(marks(manager(false)), process.env['PATH'] ?? '', {
        OPS_ASTRO_TOKEN: await token(subjects.operator),
      });
      // Positive control: on the owner's admin URL the same sign-in is the operator.
      const admitted = await requireOperatingOperator(env);
      expect(admitted.ok).toBe(true);

      const gate = await requireOperatingOperator({
        ...env,
        DATABASE_ADMIN_URL: shaped.toString(),
      });
      const reason = gate.ok ? '' : gate.reason;
      expect.soft(gate.ok).toBe(false);
      expect
        .soft(reason)
        .toContain("DATABASE_ADMIN_URL's login may not take the business lookup identity");
      expect.soft(reason).not.toContain('not a person of');
      expect.soft(reason).not.toContain(password);
    });
  },
);
