// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3e: the installation's operating business is installation state
// (migration 0034, `ops.operating_business`), written once by the owner. With
// none written, every drill mode is refused; the tenancy role reads it and
// never writes it; nothing changes or removes it once written. Each case runs
// the real gate against the real database operator-only.fixture.ts makes.

import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { drillKey, manager, marks } from './operator-only-commands.fixture.ts';
import {
  environment,
  operatorOnlyHooks,
  serverUrl,
  type OperatorOnlyState,
  subjects,
  token,
} from './operator-only.fixture.ts';
import { drillModes } from './s0-3e-operating-business.fixture.ts';

let state: OperatorOnlyState;

describe.skipIf(serverUrl === undefined)('S0-3e operating business, installed', () => {
  operatorOnlyHooks((shared) => {
    state = shared;
  });

  operatingCases6();

  operatingCases7();
});

function operatingCases6() {
  it('with no operating business written at installation, every drill mode is refused before its login is resolved', async () => {
    const signIn = await token(subjects.operator);
    const admin = state.db.admin;
    await admin.execute(
      'alter table ops.operating_business disable trigger operating_business_fixed',
    );
    await admin.execute('delete from ops.operating_business');
    try {
      for (const [name, command] of drillModes) {
        const at = marks(manager(false));
        const env = environment(at, process.env['PATH'] ?? '', {
          OPS_ASTRO_TOKEN: signIn,
          // A value the operator's environment sets appoints nothing.
          OPS_ASTRO_OPERATING_BUSINESS: 'alpha',
          RESTORE_KEY_FILE: drillKey(),
        });
        const result = command(env, at);
        expect(result.status, `${name}: ${result.out}`).toBe(1);
        expect(result.out).toMatch(/the installation has no operating business/u);
        expect(readdirSync(at.records)).toStrictEqual([]);
      }
    } finally {
      await admin.execute('insert into ops.operating_business (operating_business) values ($1)', [
        state.alphaBusiness,
      ]);
      await admin.execute(
        'alter table ops.operating_business enable trigger operating_business_fixed',
      );
    }
  });
}

function operatingCases7() {
  it('the operating business is installation state: the tenancy role reads it and never writes it, and once written it is never changed or removed', async () => {
    const tenancy = state.db.app;
    const read = await tenancy.withBusiness(
      state.alphaBusiness as never,
      async (tx) =>
        await tx.query<{ n: number }>('select count(*)::int as n from ops.operating_business'),
    );
    expect(read[0]?.n).toBe(1);
    for (const statement of [
      'insert into ops.operating_business (operating_business) select id from public.businesses',
      'update ops.operating_business set written_at = now()',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal after the other
      await expect(
        tenancy.withBusiness(state.alphaBusiness as never, async (tx) => await tx.query(statement)),
        statement,
      ).rejects.toMatchObject({ code: '42501' });
    }
    const admin = state.db.admin;
    for (const statement of [
      'update ops.operating_business set operating_business = operating_business',
      'delete from ops.operating_business',
      'truncate ops.operating_business',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal after the other
      await expect(admin.execute(statement), statement).rejects.toMatchObject({ code: '42501' });
    }
    const rows = await admin.execute<{ n: number }>(
      'select count(*)::int as n from ops.operating_business',
    );
    expect(rows[0]?.n).toBe(1);
  });
}
