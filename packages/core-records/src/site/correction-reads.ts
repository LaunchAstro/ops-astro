// SPDX-License-Identifier: AGPL-3.0-only
//
// #1694's two reads over `live_corrections` and `live_correction_receipts`:
// the corrections a reader reaches, and one correction's receipts. Each row is
// judged inside the statement that reads it, on two grants at once: the
// caller's `run:write` at the correction's own party (`COVERED`, as every read
// in `live-corrections.ts`), and their `task:read` on the correction's live
// task (`readableTaskCondition`, as every task read). A correction either
// grant misses is not read, so it is never told apart from one that does not
// exist. Unlocked: they read, and decide nothing.

import type { Subject } from '../authority/grants.ts';
import { readableTaskCondition, readableTaskParams } from '../authority/readable-scope.ts';
import type { TenantQuery } from '../tenancy/database.ts';
import { COVERED, EFFECTIVE_AT, coveringParameters } from './covering.ts';
import { RUN_COLLECTION, type CorrectionState } from './live-corrections.ts';

/** The longest receipt text a read answers, in characters; a longer one is cut and marked. */
export const RECEIPT_TEXT_LIMIT = 4_000;

export interface ReadableCorrection {
  readonly correctionId: string;
  readonly taskId: string;
  readonly state: CorrectionState;
  readonly approver: string | null;
  readonly versionId: string;
  readonly pageUrl: string;
  readonly word: string;
  readonly replacement: string;
  readonly requestedAt: string;
}

export interface ReceiptText {
  readonly text: string;
  readonly clipped: boolean;
}

export interface ReadableReceipt {
  readonly receiptId: string;
  readonly step: 'publish' | 'revert';
  readonly outcome: string;
  readonly recordedAt: string;
  readonly commit: string | null;
  readonly deploymentId: string | null;
  readonly beforeCapture: ReceiptText | null;
  readonly afterCapture: ReceiptText | null;
}

/** The most corrections a list answers, and the most receipts a correction's read answers. */
const LIST_LIMIT = 100;
const RECEIPTS_LIMIT = 10;

/** The correction `c` on its live task `r`, reached by both grants; parameters `$2`-`$7`. */
const REACHED = `public.live_corrections c
  join public.records r
    on r.business_id = c.business_id and r.id = c.task_id and r.deleted_at is null`;
const BOTH_GRANTS = `${COVERED} and ${readableTaskCondition('r', 6)}`;

/** `$2`-`$7`: the `run:write` covering, then the subjects asked of `task:read`. */
const grantParameters = (subjects: readonly Subject[]): readonly unknown[] => [
  ...coveringParameters({ subjects, collection: RUN_COLLECTION, action: 'write' }),
  ...readableTaskParams(subjects),
];

interface ListRow {
  readonly id: string;
  readonly task_id: string;
  readonly state: CorrectionState;
  readonly approver: string | null;
  readonly version_id: string;
  readonly page_url: string;
  readonly word: string;
  readonly replacement: string;
  readonly created_at: Date;
}

/** The corrections both grants reach, newest first, at most `LIST_LIMIT`. */
export async function listReadableCorrections(
  tx: TenantQuery,
  subjects: readonly Subject[],
): Promise<readonly ReadableCorrection[]> {
  const rows = await tx.query<ListRow>(
    `${EFFECTIVE_AT}
     select c.id, c.task_id, c.state, p.display_name as approver, c.version_id, c.page_url,
            c.word, c.replacement, c.created_at
       from ${REACHED}
       left join public.people p
         on p.business_id = c.business_id and p.id = c.decided_by_person_id
      where c.business_id = $1 and ${BOTH_GRANTS}
      order by c.created_at desc, c.id desc
      limit $8`,
    [tx.businessId, ...grantParameters(subjects), LIST_LIMIT],
  );
  return rows.map((row) => ({
    correctionId: row.id,
    taskId: row.task_id,
    state: row.state,
    approver: row.approver,
    versionId: row.version_id,
    pageUrl: row.page_url,
    word: row.word,
    replacement: row.replacement,
    requestedAt: row.created_at.toISOString(),
  }));
}

interface ReceiptRow {
  readonly id: string | null;
  readonly step: 'publish' | 'revert';
  readonly outcome: string;
  readonly created_at: Date;
  readonly commit: string | null;
  readonly deployment_id: string | null;
  readonly before_text: string | null;
  readonly before_clipped: boolean | null;
  readonly after_text: string | null;
  readonly after_clipped: boolean | null;
}

/** An observation's text, cut to the limit in the query; `$9` is the limit. */
const observed = (key: string): string => `left(x.observations -> '${key}' ->> 'observed', $9)`;
const clipped = (key: string): string => `length(x.observations -> '${key}' ->> 'observed') > $9`;

const textOf = (text: string | null, cut: boolean | null): ReceiptText | null =>
  text === null ? null : { text, clipped: cut === true };

/**
 * One correction's receipts, newest first, at most `RECEIPTS_LIMIT`, when both
 * grants reach it; or undefined: absent, in another business or not reached
 * are one answer. One statement judges the reach and reads the receipts, so
 * a grant revoked before it runs reads none. Each text the runner observed is
 * cut to `RECEIPT_TEXT_LIMIT` characters inside the query.
 */
export async function readReadableReceipts(
  tx: TenantQuery,
  correctionId: string,
  subjects: readonly Subject[],
): Promise<
  { readonly correctionId: string; readonly receipts: readonly ReadableReceipt[] } | undefined
> {
  const rows = await tx.query<ReceiptRow>(
    `${EFFECTIVE_AT}
     select x.id, x.step, x.outcome, x.created_at,
            ${observed('published_revision')} as commit,
            ${observed('deployment_id')} as deployment_id,
            ${observed('before_capture')} as before_text,
            ${clipped('before_capture')} as before_clipped,
            ${observed('after_capture')} as after_text,
            ${clipped('after_capture')} as after_clipped
       from ${REACHED}
       left join lateral (
         select x.id, x.step, x.outcome, x.created_at, x.observations
           from public.live_correction_receipts x
          where x.business_id = c.business_id and x.correction_id = c.id
          order by x.created_at desc, x.id desc
          limit $10) x on true
      where c.business_id = $1 and c.id = $8 and ${BOTH_GRANTS}
      order by x.created_at desc, x.id desc`,
    [tx.businessId, ...grantParameters(subjects), correctionId, RECEIPT_TEXT_LIMIT, RECEIPTS_LIMIT],
  );
  if (rows.length === 0) return undefined;
  const receipts = rows.flatMap((row) =>
    row.id === null
      ? []
      : [
          {
            receiptId: row.id,
            step: row.step,
            outcome: row.outcome,
            recordedAt: row.created_at.toISOString(),
            commit: row.commit,
            deploymentId: row.deployment_id,
            beforeCapture: textOf(row.before_text, row.before_clipped),
            afterCapture: textOf(row.after_text, row.after_clipped),
          },
        ],
  );
  return { correctionId, receipts };
}
