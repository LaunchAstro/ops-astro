// SPDX-License-Identifier: AGPL-3.0-only
//
// The identifier suites' reads of what a call left behind: a digest of every
// other tenant table per business, and the audit rows written since a mark,
// each checked against what the case expects. Split from `ident-audit-cases.ts`
// so each stays under the per-file cap.

import { expect } from 'vitest';
import { type Harness } from './role-case-harness.ts';
import { isUuid } from '../../packages/core-records/src/tenancy/ids.ts';
import { type Body, EVIDENCE_TABLES } from './ident-audit-cases.ts';

/**
 * One digest per business over every other tenant table, every row, every
 * column. A refusal that moved anything (a revision, a lease's expiry, a
 * delegation's revocation stamp, a grant) changes it.
 */
export async function domainState(
  h: Harness,
  businessIds: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  const admin = h.world.db.admin;
  const tables = await admin.execute<{ readonly table_name: string }>(
    `select distinct c.table_name from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and c.column_name = 'business_id'
        and t.table_type = 'BASE TABLE'
      order by c.table_name`,
  );
  const out: Record<string, string> = {};
  for (const businessId of businessIds) {
    const parts: string[] = [];
    for (const { table_name: table } of tables) {
      if (EVIDENCE_TABLES.has(table)) continue;
      // eslint-disable-next-line no-await-in-loop -- one table at a time, serially
      const rows = await admin.execute<{ readonly d: string }>(
        `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as d
           from public.${table} t where t.business_id = $1`,
        [businessId],
      );
      parts.push(`${table}=${rows[0]?.d ?? ''}`);
    }
    out[businessId] = parts.join(';');
  }
  return out;
}

export type AuditRow = Readonly<
  Record<'business_id' | 'seq' | 'actor_id' | 'command' | 'outcome' | 'payload_digest', string> &
    Record<'operation_id' | 'refusal_code' | 'subject_record_id', string | null> & {
      attempted: unknown;
    }
>;

/** Where each business's chain stands, so a probe's own rows can be told apart. */
export async function auditMark(h: Harness): Promise<ReadonlyMap<string, bigint>> {
  const rows = await h.world.db.admin.execute<{ readonly business_id: string; readonly s: string }>(
    `select b.id as business_id, coalesce(max(a.seq), 0)::text as s
       from public.businesses b left join public.audit_events a on a.business_id = b.id
      group by b.id`,
  );
  return new Map(rows.map((row) => [row.business_id, BigInt(row.s)]));
}

/** Every audit row written in any business since `mark`. */
export async function auditSince(
  h: Harness,
  mark: ReadonlyMap<string, bigint>,
): Promise<readonly AuditRow[]> {
  const rows = await h.world.db.admin.execute<AuditRow>(
    `select business_id, seq::text as seq, actor_id, command, operation_id, outcome,
            refusal_code, subject_record_id::text as subject_record_id, payload_digest, attempted
       from public.audit_events order by business_id, seq`,
  );
  return rows.filter((row) => BigInt(row.seq) > (mark.get(row.business_id) ?? 0n));
}

/** The string values a body carries that are content rather than identity. */
function contentOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.length >= 4 && !isUuid(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const one of value) contentOf(one, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const one of Object.values(value)) contentOf(one, out);
  }
  return out;
}

export interface AuditExpectation {
  readonly businessId: string;
  readonly actorId: string;
  readonly command: string;
  readonly operationId: string | null;
  readonly outcome: 'applied' | 'refused';
  readonly refusalCode: string | null;
  readonly body: Body;
}

/**
 * Exactly one row for this attempt, in the caller's own business and nowhere
 * else, naming who, what, which operation and how it ended, and carrying the
 * request only as a digest.
 */
export function expectAudited(
  label: string,
  rows: readonly AuditRow[],
  expected: AuditExpectation,
): void {
  const elsewhere = rows.filter((row) => row.business_id !== expected.businessId);
  expect(elsewhere, `${label}: audit outside the caller's business`).toStrictEqual([]);
  const own = rows.filter((row) => row.command === expected.command);
  expect(own, `${label}: audit rows for ${expected.command}`).toHaveLength(1);
  const row = own[0] as AuditRow;
  expect(
    [row.actor_id, row.command, row.operation_id, row.outcome, row.refusal_code],
    `${label}: actor, command, operation, outcome, code`,
  ).toStrictEqual([
    expected.actorId,
    expected.command,
    expected.operationId,
    expected.outcome,
    expected.refusalCode,
  ]);
  expect(row.payload_digest, `${label}: digest`).toMatch(/^[0-9a-f]{64}$/u);
  expect(row.attempted, `${label}: attempted`).toBeNull();
  const stored = JSON.stringify(row);
  for (const content of contentOf(expected.body)) {
    expect(stored.includes(content), `${label}: audit row carries "${content}"`).toBe(false);
  }
}
