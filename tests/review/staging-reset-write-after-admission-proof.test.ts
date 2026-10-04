// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  beforeNextCall,
  onDatabase,
  run,
  serverUrl,
  settings,
  stagingResetHooks,
} from '../ci/s0-1-staging-reset.fixture.ts';

stagingResetHooks();

it.skipIf(serverUrl === undefined)(
  'a tenant write after reset admission survives a refused first reset',
  async () => {
    await onDatabase((admin) => admin.execute(
      'create table public.sol_customer_data (business_id uuid, content text)',
    ));
    let inserted = false;
    // The key check runs after resettable and before the first DROP SCHEMA.
    beforeNextCall.work = async () => {
      await onDatabase((admin) => admin.execute(
        'insert into public.sol_customer_data values ($1, $2)',
        [randomUUID(), 'customer data arriving after admission'],
      ));
      inserted = true;
    };
    const result = await run(settings());
    expect(inserted, 'the competing write committed before the schema drop').toBe(true);
    const [state] = await onDatabase((admin) => admin.execute<{ kept: boolean }>(
      "select to_regclass('public.sol_customer_data') is not null as kept",
    ));
    expect({ status: result.status, kept: state?.kept }, result.out).toEqual({ status: 1, kept: true });
  },
  180_000,
);
