// SPDX-License-Identifier: AGPL-3.0-only
//
// One broken connection, written as the database owner. Connection rows are
// written by the connector's setup (MP-13-5) and the broker's sync (AW-01),
// neither built, so a suite that needs a connection to repair seeds one here.

import { randomUUID } from 'node:crypto';

export interface OwnerConnection {
  execute(sql: string, params?: readonly unknown[]): Promise<unknown>;
}

export async function seedBrokenConnection(
  admin: OwnerConnection,
  business: string,
  label = 'a broken source',
): Promise<string> {
  const id = randomUUID();
  await admin.execute(
    `insert into public.connections (business_id, id, connector_key, label, status, failure_class)
     values ($1, $2, 'seeded', $3, 'broken', 'auth_expired')`,
    [business, id, label],
  );
  return id;
}
