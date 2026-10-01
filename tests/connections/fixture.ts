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

/**
 * One graduation row that clears the bar (MP-14-10a), owner-written: the
 * agent loops write these as decisions land (AW-01), not built.
 */
export async function seedReadyClass(
  admin: OwnerConnection,
  business: string,
): Promise<{ readonly classId: string; readonly clientId: string }> {
  const classId = randomUUID();
  const clientId = randomUUID();
  await admin.execute(
    `insert into public.graduation_classes
       (business_id, id, client_id, client_label, action_class, class_label, earned, approved)
     values ($1, $2, $3, 'a seeded client', 'social.post', 'Posts', 'ready', 30)`,
    [business, classId, clientId],
  );
  return { classId, clientId };
}

/** One standing approval on a seeded client, owner-written (MP-14-10a). */
export async function seedMandate(
  admin: OwnerConnection,
  business: string,
  clientId: string,
  authorActorId: string,
): Promise<string> {
  const id = randomUUID();
  await admin.execute(
    `insert into public.standing_mandates
       (business_id, id, client_id, classes, refuses, ceiling_minor, currency, expires_at, label,
        authored_by_actor_id)
     values ($1, $2, $3, '{*}', false, 100, 'AUD', now() + interval '1 day', 'a seeded mandate', $4)`,
    [business, id, clientId, authorActorId],
  );
  return id;
}
