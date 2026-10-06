// SPDX-License-Identifier: AGPL-3.0-only
//
// API-2 quota on export when reads run at once (Sol OW-001, criterion 5).
// Two reads let in together both saw room at the door; the one whose answer
// would pass the limit is refused when it is decided, inside its transaction,
// so its read's audit row rolls back with it and nothing records a hand-out
// the caller never got.

import { expect, it } from 'vitest';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { serverUrl } from '../acceptance/world.ts';
import { harness, openWorld } from './api-2-agent-credential-world.ts';
import { issued, latch } from './api-2-agent-credential-use-world.ts';
import { limited, readWith } from './api-2-agent-credential-quota-world.ts';

openWorld();

const needsServer = it.skipIf(serverUrl === undefined);

/** Applied `task.read` rows recorded for the credential's agent. */
async function appliedReads(credentialId: string): Promise<number> {
  const rows = await harness.world.db.admin.execute<{ readonly n: number }>(
    `select count(*)::int as n
       from public.audit_events e
       join public.agent_credentials c
         on c.business_id = e.business_id and c.agent_actor_id = e.actor_id
      where c.id = $1 and e.command = 'task.read' and e.outcome = 'applied'`,
    [credentialId],
  );
  return rows[0]?.n ?? 0;
}

needsServer(
  'API-2 quota on export: of two reads let in together past a limit of one, one is refused and its read is not recorded',
  async () => {
    const pool = connect(harness.world.db.appUrl, { max: 2 });
    const bothIn = latch();
    let entered = 0;
    // Each read waits, once its credential is resolved and it is let in, until
    // both are: so both pass the door before either answer is decided.
    const held: Database = {
      ...pool,
      withBusiness: async (businessId, run) =>
        await pool.withBusiness(businessId, async (tx) => {
          let resolved = false;
          let waited = false;
          return await run({
            ...tx,
            query: async <Row>(text: string, parameters?: readonly unknown[]) => {
              if (resolved && !waited) {
                waited = true;
                entered += 1;
                if (entered === 2) bothIn.open();
                await bothIn.promise;
              }
              const rows = await tx.query<Row>(text, parameters);
              if (text.includes('for share of c')) resolved = true;
              return rows;
            },
          });
        }),
    };
    const { api } = limited({ exports: { credential: 1, person: 1, business: 1 } }, held);
    const credential = await issued();
    const codes = await Promise.all([
      readWith(api, credential.secret),
      readWith(api, credential.secret),
    ]).finally(async () => await pool.close());
    expect(codes.map((answer) => answer.code).toSorted()).toEqual(['AGENT_QUOTA_EXCEEDED', 'ok']);
    expect(await appliedReads(credential.id), 'only the read handed out is recorded').toBe(1);
  },
);
