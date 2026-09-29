// SPDX-License-Identifier: AGPL-3.0-only
//
// Charting's pre-answers (WF-6): the open questions recorded decisions already
// settle, each answered with the one source it cites, a closed ticket or a
// written reference; the obvious calls are marked "decided, veto open"
// (CS-15.5). An uncited pre-answer is refused. A cited record must be one the
// charter may read, else it answers as a record that does not exist, and a
// closed one, else it is no recorded decision. Pre-answers resolve nothing.

import { randomUUID } from 'node:crypto';
import { isUuid, subjectsOf } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import { mayRead } from '../reads/detail.ts';
import { refuseCommand } from './refusal.ts';
import { refused, type HandlerOutcome } from './outcome.ts';
import type { CommandContext } from './context.ts';
import { invalid, textOk } from './wayfinder.ts';
import { completed } from './wayfinder-resolve.ts';

export const REFERENCE_LIMIT = 400;

export type PreAnswerSource = { readonly recordId: string } | { readonly reference: string };

export interface PreAnswer {
  readonly question: string;
  readonly answer: string;
  readonly source: PreAnswerSource;
  readonly vetoOpen: boolean;
}

export const PRE_ANSWER_FIXES: readonly string[] = [
  'preAnswers is a list of { question, answer, source, vetoOpen? }.',
  `Each cites one source: { recordId } of a closed ticket, or { reference }, one line of 1 to ${String(REFERENCE_LIMIT)} characters.`,
];

function sourceOf(value: unknown): PreAnswerSource | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { recordId, reference, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || (recordId === undefined) === (reference === undefined)) {
    return null;
  }
  if (recordId !== undefined) return isUuid(recordId) ? { recordId: recordId.toLowerCase() } : null;
  const line = typeof reference === 'string' ? reference.trim() : '';
  if (line === '' || line.length > REFERENCE_LIMIT || /[\r\n]/u.test(line)) return null;
  return { reference: line };
}

function preAnswerOf(value: unknown): PreAnswer | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { question, answer, source, vetoOpen, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || !textOk(question) || !textOk(answer)) return null;
  if (vetoOpen !== undefined && typeof vetoOpen !== 'boolean') return null;
  const cited = sourceOf(source);
  if (cited === null) return null;
  return { question, answer, source: cited, vetoOpen: vetoOpen ?? false };
}

/** Up to 100 pre-answers, every one cited, or undefined when the list or any entry is wrong. */
export function preAnswerList(value: unknown): readonly PreAnswer[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) return undefined;
  const out: PreAnswer[] = [];
  for (const entry of value as readonly unknown[]) {
    const parsed = preAnswerOf(entry);
    if (parsed === null) return undefined;
    out.push(parsed);
  }
  return out;
}

/**
 * Every cited record is a closed task of this business the charter may read.
 * One it may not read, or that does not exist here, is refused NOT_FOUND
 * naming neither it nor why; an open one is no recorded decision.
 */
export async function refuseUncitable(
  tx: TenantQuery,
  context: CommandContext,
  preAnswers: readonly PreAnswer[],
): Promise<HandlerOutcome | undefined> {
  const ids = [
    ...new Set(preAnswers.flatMap((p) => ('recordId' in p.source ? [p.source.recordId] : []))),
  ];
  if (ids.length === 0) return undefined;
  const rows = await tx.query<{ readonly id: string; readonly state: string | null }>(
    `select id, uuid_1::text as state from records
      where business_id = $1 and id = any($2::uuid[]) and record_type_id = $3
        and deleted_at is null`,
    [tx.businessId, ids, context.spine.taskTypeId],
  );
  const subjects = subjectsOf(context.session);
  const found = new Map(rows.map((row) => [row.id, row.state]));
  for (const id of ids) {
    // One grant check per cited record, on one transaction.
    // oxlint-disable-next-line no-await-in-loop
    if (!found.has(id) || !(await mayRead(tx, subjects, id))) {
      return refused(
        refuseCommand('NOT_FOUND', ['preAnswers'], ['Cite a closed ticket you may read.']),
      );
    }
  }
  if (ids.some((id) => !completed(context, found.get(id)))) {
    return invalid(['preAnswers'], ['A cited record is a closed ticket: a recorded decision.']);
  }
  return undefined;
}

/** Write the pre-answers as components of this version, in order: the ids written. */
export async function writePreAnswers(
  tx: TenantQuery,
  mapId: string,
  version: number,
  preAnswers: readonly PreAnswer[],
): Promise<readonly string[]> {
  const ids: string[] = [];
  for (const item of preAnswers) {
    const id = randomUUID();
    const recordId = 'recordId' in item.source ? item.source.recordId : null;
    const reference = 'reference' in item.source ? item.source.reference : null;
    // In order: each takes the next position.
    // oxlint-disable-next-line no-await-in-loop
    await tx.query(
      `insert into map_components
         (business_id, id, map_id, kind, body, question, source_record_id, source_reference,
          veto_open, position, created_version)
       values ($1, $2, $3, 'pre_answer', $4, $5, $6, $7, $8,
               coalesce((select max(position) + 1 from map_components
                          where business_id = $1 and map_id = $3 and kind = 'pre_answer'), 0),
               $9)`,
      [
        tx.businessId,
        id,
        mapId,
        item.answer.trim(),
        item.question.trim(),
        recordId,
        reference,
        item.vetoOpen,
        version,
      ],
    );
    ids.push(id);
  }
  return ids;
}
