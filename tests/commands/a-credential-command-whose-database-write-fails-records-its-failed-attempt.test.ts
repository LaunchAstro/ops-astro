// SPDX-License-Identifier: AGPL-3.0-only
//
// A command an agent credential sends whose database write raises, past the
// one retry, rolls its transaction back. Its attempt is still on the audit
// chain: one `failed` event, attributed to the credential's agent actor, in a
// transaction of its own, as the person entry records one (`recordFailure`).
// The fault itself still reaches the caller.
//
// The write is failed by a wrapper around the call's database: every insert
// into `public.records` (a task is a record) raises, on both tries.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeCredentialCommand } from '../../packages/core-commands/src/commands/credential-envelope.ts';
import type { Database, TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { detailOf, issueAs, issueBody, issuerIn } from '../authority/agent-credential-issuer.ts';

const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

let world: World;

beforeAll(async () => {
  if (serverUrl !== undefined) world = await createWorld('credfailedattempt');
}, 120_000);

afterAll(async () => {
  if (serverUrl !== undefined) await world.close();
});

class RecordInsertFailed extends Error {}

/** `database`, with every insert into `public.records` raising. */
function failingRecordInserts(database: Database): Database {
  const wrap = (tx: TenantQuery): TenantQuery =>
    new Proxy(tx, {
      get(target, property, receiver) {
        if (property !== 'query') return Reflect.get(target, property, receiver) as unknown;
        return async (text: string, parameters?: readonly unknown[]) => {
          if (/insert\s+into\s+(?:public\.)?records\b/iu.test(text)) {
            throw new RecordInsertFailed('the record insert failed');
          }
          return await target.query(text, parameters);
        };
      },
    });
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property !== 'withBusiness') return Reflect.get(target, property, receiver) as unknown;
      return async <T>(
        businessId: Parameters<Database['withBusiness']>[0],
        run: (tx: TenantQuery) => Promise<T>,
      ): Promise<T> => await target.withBusiness(businessId, async (tx) => await run(wrap(tx)));
    },
  });
}

it('a credential command whose database write fails records its failed attempt', async () => {
  const issuer = await issuerIn(world);
  const issued = detailOf(await issueAs(world, issuer, issueBody()));
  const operationId = randomUUID();
  await expect(
    executeCredentialCommand(
      failingRecordInserts(world.db.app),
      world.alpha,
      { credential: String(issued['credential']), now: new Date() },
      { command: 'task.create', operationId, fields: { title: 'written by the agent' } },
    ),
  ).rejects.toBeInstanceOf(RecordInsertFailed);
  const events = await world.db.admin.execute<{
    readonly actor_id: string;
    readonly outcome: string;
  }>(`select actor_id, outcome from public.audit_events where operation_id = $1`, [operationId]);
  expect(events).toEqual([{ actor_id: issued['agentActorId'], outcome: 'failed' }]);
}, 60_000);
