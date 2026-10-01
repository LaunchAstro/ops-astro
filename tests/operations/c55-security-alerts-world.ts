// SPDX-License-Identifier: AGPL-3.0-only
//
// What the C55 security-alert cases share (`c55-security-alerts.test.ts`): a
// stand-in error sink, the real forwarder on the harness's database, and the
// grants held on the alert log, read from the catalogue by grantee.

import { resolve } from 'node:path';
import type { SinkEvent } from '../../apps/api/alerts/sink.ts';
import { createForwarder } from '../../apps/forwarder/forward.ts';
import type { AdminConnection } from '../../packages/core-records/src/index.ts';

export const ROOT: string = resolve(import.meta.dirname, '../..');

/** One security alert as the operations view lists it. */
export interface AlertView {
  readonly kind: string;
  readonly at: string;
  readonly concerns: string;
}

export interface TestSink {
  readonly events: SinkEvent[];
  readonly send: (event: SinkEvent) => Promise<void>;
}

/** A sink that takes every event, or refuses each with `failWith` as its words. */
export function sink(failWith?: string): TestSink {
  const events: SinkEvent[] = [];
  return {
    events,
    send: (event: SinkEvent): Promise<void> =>
      failWith === undefined
        ? Promise.resolve(void events.push(event))
        : Promise.reject(new Error(failWith)),
  };
}

/** The real forwarder; it takes `ops_astro_forwarder` in its own transaction, as it always does. */
export const forwarderOn = (
  database: AdminConnection,
  to: TestSink,
): ReturnType<typeof createForwarder> =>
  createForwarder({ database, send: to.send, where: 'staging', root: ROOT });

/**
 * Every grant on the alert log but its owner's, as `grantee PRIVILEGE column`
 * (`*` for the whole table); PUBLIC is grantee 0.
 */
export async function grantsOnAlertLog(admin: AdminConnection): Promise<readonly string[]> {
  const rows = await admin.execute<{ held: string }>(
    `select coalesce(r.rolname, 'PUBLIC') || ' ' || a.privilege_type || ' ' || a.col as held
       from (select (aclexplode(c.relacl)).*, '*' as col from pg_class c
              where c.oid = 'ops.security_alert_log'::regclass
             union all
             select (aclexplode(t.attacl)).*, t.attname::text from pg_attribute t
              where t.attrelid = 'ops.security_alert_log'::regclass and t.attacl is not null) a
       left join pg_roles r on r.oid = a.grantee
      where a.grantee <> (select relowner from pg_class
                           where oid = 'ops.security_alert_log'::regclass)
      order by 1`,
  );
  return rows.map((row) => row.held);
}
