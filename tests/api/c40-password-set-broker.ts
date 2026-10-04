// SPDX-License-Identifier: AGPL-3.0-only
//
// The C40 reset world's custody and broker (ORCH77-C40B): custody holding a
// service key for the `auth` destination, whose one route is the admin
// update of one user (no POST at all, SEC37 M1), a broker cataloguing `auth.update_user_password`, and
// the route's database with a fault that can be injected after its change.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUTH_UPDATE_USER_PASSWORD,
  authPasswordAdapter,
  catalogue,
} from '../../packages/core-connectors/src/index.ts';
import { startCustody, type Broker, type Custody } from '../../packages/core-custody/src/index.ts';
import type {
  BusinessId,
  Database,
  TransactionQuery,
} from '../../packages/core-records/src/index.ts';

/** Custody holding the service key for `origin`, and a broker cataloguing the password update. */
export async function brokerFor(
  origin: string,
  key: string,
  dir: string,
): Promise<{ readonly broker: Broker; readonly custody: Custody }> {
  const credentialsFile = join(dir, 'credentials.json');
  const credential = { ref: 'auth_key', destination: 'auth', account: 'auth-1', value: key };
  writeFileSync(
    credentialsFile,
    JSON.stringify([{ ...credential, kind: 'api_key', header: 'authorization' }]),
    { mode: 0o600 },
  );
  const started = await startCustody({
    credentialsFile,
    destinations: [
      {
        key: 'auth',
        origin,
        post: false,
        routes: [{ method: 'PUT', path: '/auth/v1/admin/users/*' }],
      },
    ],
  });
  const catalogued: Broker = {
    custody: started,
    operations: catalogue([{ ...AUTH_UPDATE_USER_PASSWORD, timeoutMs: 1500 }]),
    providers: new Map([
      ['supabase_auth_password', { build: authPasswordAdapter, price: () => 0 }],
    ]),
    routes: [
      {
        key: 'auth',
        reach: 'cloud',
        provider: 'supabase_auth_password',
        credentialRef: 'auth_key',
        credentialKind: 'api_key',
        installation: 'here',
        ceiling: 4,
      },
    ],
    installation: 'here',
    audit: async () => {
      await Promise.resolve();
    },
  };
  return { broker: catalogued, custody: started };
}

/** The app database as the route has it: the same, but for an injected fault. */
export function routeDatabase(app: Database, faultIn: () => BusinessId | undefined): Database {
  async function withBusiness<T>(
    business: BusinessId,
    run: (tx: TransactionQuery) => Promise<T>,
  ): Promise<T> {
    return await app.withBusiness(business, async (tx) => {
      // The reset's change in a business: its sessions' ending (read from the
      // sessions it saw), or its audit row.
      let changing = false;
      const watched: TransactionQuery = {
        ...tx,
        query: async <Row>(text: string, parameters?: readonly unknown[]) => {
          changing ||= /insert into audit_events|select distinct a\.session_id/u.test(text);
          return await tx.query<Row>(text, parameters);
        },
      };
      const done = await run(watched);
      if (changing && business === faultIn())
        throw new Error('an injected fault, after the change');
      return done;
    });
  }
  return { ...app, withBusiness };
}
