// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one interleaving, read top to bottom */
//
// C35 (#2114), ORCH-2114-AUDIT condition 2. `task.read` answers from one snapshot taken
// at admission (ORCH-2114-T5), and its audit row is written after it, never under that
// snapshot: the audit chain locks the business and reads its head, and a head read from
// the snapshot would miss a row committed since. An audited write that commits in the
// same business while the read is served must leave the read applied and the chain whole:
// no read failing on `audit_events_chain_key`, no position taken twice.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, wayfinderWorld, type Decider, type WayfinderWorld } from '../wayfinder/world.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: WayfinderWorld;
let owner: Decider;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await wayfinderWorld('c35auditchain', 'c35auditchain');
  owner = await w.decider('Audit chain owner');
}, 180_000);
afterAll(async () => await w?.drop());

describe.skipIf(serverUrl === undefined)('a task read and the audit chain', () => {
  it('an audited write committed during a task read keeps the read applied and the chain whole', async () => {
    const ticket = await w.create(owner, { title: 'Audit chain ticket' });
    const reader = await w.member('Audit chain reader', ['read']);
    let crossed = false;
    const database: Database = {
      log: w.db.app.log,
      close: async () => {},
      withBusiness: async (business, run, options) =>
        await w.db.app.withBusiness(
          business,
          async (tx) =>
            await run({
              ...tx,
              query: async (sql, params) => {
                const rows = await tx.query(sql, params);
                // Served: the task row is read, and another audited event commits now.
                if (!crossed && sql.includes('r.txt_4 as title') && sql.includes('r.id = $3')) {
                  crossed = true;
                  await w.db.admin.execute(
                    `insert into public.audit_events
                       (business_id, id, actor_id, command, operation_id, outcome, refusal_code,
                        subject_record_id, payload_digest, attempted, seq, prev_hash, hash)
                     values ($1, gen_random_uuid(), $2, 'task.update', null, 'applied', null,
                             $3::uuid, $4, null, 1, null, repeat('0', 64))`,
                    [w.business, owner.actorId, ticket.id, 'c'.repeat(64)],
                  );
                }
                return rows as never;
              },
            }),
          options,
        ),
    };
    const answer = await executeRead(database, w.business, reader.presented, {
      read: 'task.read',
      recordId: ticket.id,
    });
    expect(crossed).toBe(true);
    expect(codeOf(answer)).toBe('applied');
    const audit = await w.db.app.withBusiness(w.business, async (tx) => ({
      chain: await verifyAuditChain(tx),
      rows: await tx.query<{ seq: string; command: string; payload_digest: string }>(
        `select seq::text as seq, command, payload_digest from public.audit_events
          where business_id = $1 order by seq`,
        [w.business],
      ),
    }));
    const seqs = audit.rows.map((row) => Number(row.seq));
    expect(audit.chain.intact).toBe(true);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toStrictEqual(seqs.map((_, index) => index + 1));
    // The crossing's event, then the read's own, each in its own position.
    expect(audit.rows.slice(-2).map((row) => row.command)).toStrictEqual([
      'task.update',
      'task.read',
    ]);
  }, 30_000);
  it('a task read whose audit write fails gives the caller the failure, never the answer', async () => {
    const marker = 'c35-answer-held-until-its-audit-commits';
    const ticket = await w.create(owner, { title: marker });
    const reader = await w.member('Audit failure reader', ['read']);
    let refusedAudit = false;
    const database: Database = {
      log: w.db.app.log,
      close: async () => {},
      withBusiness: async (business, run, options) =>
        await w.db.app.withBusiness(
          business,
          async (tx) =>
            await run({
              ...tx,
              query: async (sql, params) => {
                if (/insert into audit_events/u.test(sql) && params?.[3] === 'task.read') {
                  refusedAudit = true;
                  throw new Error('the audit write failed');
                }
                return (await tx.query(sql, params)) as never;
              },
            }),
          options,
        ),
    };
    const outcome = await executeRead(database, w.business, reader.presented, {
      read: 'task.read',
      recordId: ticket.id,
    }).then(
      (answer) => ({ answered: true, leaked: JSON.stringify(answer).includes(marker) }),
      (error: unknown) => ({ answered: false, failure: String(error) }),
    );
    expect(refusedAudit).toBe(true);
    expect(outcome).toStrictEqual({ answered: false, failure: 'Error: the audit write failed' });
  }, 30_000);
});
