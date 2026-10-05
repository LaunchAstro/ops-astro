// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #412: Sol's PRV-oa-745-R3 proof (title named by behaviour, body
// unchanged; R/sol/proofs/PRV-oa-745-R3-c35c97775.patch). A task-grant
// revocation that commits just before the conversation's content statement
// hides the task's title, because that statement asks the live grants itself.
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import {
  connect,
  revokeGrant,
  type Database,
  type TransactionQuery,
} from '../../packages/core-records/src/index.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { conversationWorld, started, type ConversationWorld } from './aw-03-fixture.ts';
import { serverUrl } from '../acceptance/world.ts';

const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

let w: ConversationWorld;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await conversationWorld('sol745r3race');
}, 180_000);
afterAll(async () => await w?.drop());

/** Commit a real concurrent revocation immediately before the content statement. */
function revokeBeforeContent(grant: string, committed: () => void): Database {
  const app = w.fixture.db.app;
  return {
    log: app.log,
    close: async () => {},
    withBusiness: async (businessId, run) =>
      await app.withBusiness(businessId, async (tx) => {
        const watched: TransactionQuery = {
          businessId: tx.businessId,
          savepoint: tx.savepoint,
          async query<Row>(statement: string, parameters?: readonly unknown[]) {
            if (/select id,/u.test(statement) && /from conversations\s+where/u.test(statement)) {
              const other = connect(w.fixture.db.appUrl);
              try {
                await other.withBusiness(businessId, async (concurrent) => {
                  expect(await revokeGrant(concurrent, grant)).not.toBeNull();
                });
                committed();
              } finally {
                await other.close();
              }
            }
            return await tx.query<Row>(statement, parameters);
          },
        };
        return await run(watched);
      }),
  };
}

it.each(['conversation.list', 'conversation.read'] as const)(
  'person to person %s hides a task title when revocation commits before the content statement',
  async (read) => {
    const hidden = `SOL745R3_REVOKED_TASK_TITLE_${read}`;
    const created = await w.as(w.owner, 'task.create', { fields: { title: hidden } });
    expect(created.status).toBe(200);
    const taskId = String(created.body['recordId']);
    const reader = await enrol(w.fixture.db.app, w.fixture.business, `race-${read}`);
    const grant = await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      await grantTo(tx, reader, 'write', undefined, false, 'conversation');
      return await grantTo(tx, reader, 'read', { kind: 'record', id: taskId });
    });
    const conversationId = await started(w, reader, {
      scope: { kind: 'task', id: taskId },
      subject: hidden,
      body: 'A message independent of the task title',
    });
    expect((await w.as(reader, 'task.read', { recordId: taskId })).status).toBe(200);
    let committed = false;
    const answer = await executeRead(
      revokeBeforeContent(grant, () => {
        committed = true;
      }),
      w.fixture.business,
      reader.presented,
      read === 'conversation.list' ? { read } : { read, conversationId },
    );
    expect(committed, 'the concurrent revocation committed before the content SELECT').toBe(true);
    expect((await w.as(reader, 'task.read', { recordId: taskId })).status).toBe(403);
    expect(answer).toMatchObject({ ok: true });
    expect(
      JSON.stringify(answer),
      'the response used task reach from before the committed revocation',
    ).not.toContain(hidden);
  },
);
