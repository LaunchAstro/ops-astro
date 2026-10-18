// SPDX-License-Identifier: AGPL-3.0-only
//
// A model turn at the broker (#1623 R3, design R4 and R7): read, bound, then
// made into the one field its operation sends.
//
// 1. Read (`broker-turn-read.ts`). The bounded parsers take the turn's shape
//    and order before anything is looked up: at most 64 parts, a system part
//    only first, each part's keys exactly its kind's, tool-call ids unique,
//    each tool result after the call it answers and only once, arguments at
//    most 16 KiB. Out of shape is `TURN_MALFORMED`, never a re-ask.
// 2. Bind. Every part is a reference to something the broker owns, read here
//    under the call's locks: the attempt's own task at its current revision,
//    or an earlier answer of this attempt, matched by the digest its
//    settlement kept, or a correction this attempt's delegation requested on
//    that task (#1624 R7), shown as its id and state alone. A definition (a pinned file the run read) is refused:
//    its kept copy is insert-only for the application (0086), and its read
//    path waits on #1904. Anything else, or a mismatch, is
//    `PROVENANCE_UNBOUND`, in the same bytes whoever's it was:
//    the lookups are scoped to the business and the attempt, so a foreign row
//    is never read.
// 3. Check the tools. Only once the answers' bytes are bound: each tool
//    offered and asked for is the catalogue's, with arguments of its schema.
//
// The turn's class is its strictest source's. An answer's is the class its
// call was made with, kept beside its digest, so a model's output never
// becomes less strict on a later turn.

import { payloadDigest } from '../../core-digest/src/index.ts';
import type { FieldSource, ModelOperation } from '../../core-connectors/src/index.ts';
import { isUuid, TASK_SPINE, type TenantQuery } from '../../core-records/src/index.ts';
import type { ToolCall, TurnPart } from '../../core-wire/src/index.ts';
import type { Facts } from './broker-facts.ts';
import { businessInternal, resolveFields } from './broker-sources.ts';
import { readTurn, toolsKept, type Part, type Turn } from './broker-turn-read.ts';
import type { BrokerRefusal, ModelCallRequest, ResolvedField } from './broker-types.ts';

/** What binding reads of the call's facts: its lease and its task as held. */
type Bindings = Pick<Facts, 'leaseId' | 'source'>;

/** The answer's digest: sha256 of the canonical JSON (RFC 8785's order) of its bytes. */
export const answerDigest = (text: string, toolCalls: readonly ToolCall[]): string =>
  payloadDigest({ v: 1, text, toolCalls });

/** The task fields an external reader, and so the agent, is shown. */
const SHOWN = TASK_SPINE.filter((field) => field.visibilityClass === 'shared').map((f) => f.key);

type Message =
  | { readonly role: 'system' | 'user'; readonly text: string }
  | { readonly role: 'assistant'; readonly text: string; readonly toolCalls: readonly ToolCall[] }
  | { readonly role: 'tool'; readonly toolCallId: string; readonly text: string };

type Bound = { readonly message: Message; readonly source: FieldSource } | undefined;

function taskMessage(facts: Bindings, part: TurnPart & { ref: 'task' }): Bound {
  const task = facts.source;
  if (part.taskId !== task.id || !task.live || part.revision !== task.revision) return undefined;
  const shown = Object.fromEntries(
    SHOWN.filter((key) => Object.hasOwn(task.data, key)).map((key) => [key, task.data[key]]),
  );
  const text = JSON.stringify(shown);
  const source: FieldSource = businessInternal(task) ? 'business_internal' : 'outside';
  const message: Message =
    part.toolCallId === undefined
      ? { role: 'user', text }
      : { role: 'tool', toolCallId: part.toolCallId, text };
  return { message, source };
}

async function answerMessage(
  tx: TenantQuery,
  facts: Bindings,
  part: TurnPart & { ref: 'answer' },
): Promise<Bound> {
  if (!isUuid(part.callId)) return undefined;
  const [call] = await tx.query<{ answer_source: FieldSource }>(
    `select answer_source from public.model_calls
      where business_id = $1 and id = $2 and lease_id = $3 and state = 'settled'
        and answer_digest = $4`,
    [tx.businessId, part.callId, facts.leaseId, answerDigest(part.text, part.toolCalls)],
  );
  if (call === undefined) return undefined;
  const message: Message = { role: 'assistant', text: part.text, toolCalls: part.toolCalls };
  return { message, source: call.answer_source };
}

/** A correction the run's own delegation requested on its task: its id and state, never its words. */
async function correctionMessage(
  tx: TenantQuery,
  facts: Bindings,
  part: TurnPart & { ref: 'correction' },
): Promise<Bound> {
  if (!isUuid(part.correctionId)) return undefined;
  const [row] = await tx.query<{ state: string }>(
    `select c.state from public.live_corrections c
       join public.leases l on l.business_id = c.business_id and l.delegation_id = c.delegation_id
      where c.business_id = $1 and c.id = $2 and c.task_id = $3 and l.id = $4`,
    [tx.businessId, part.correctionId, facts.source.id, facts.leaseId],
  );
  if (row === undefined) return undefined;
  const text = JSON.stringify({ correctionId: part.correctionId.toLowerCase(), state: row.state });
  const source: FieldSource = businessInternal(facts.source) ? 'business_internal' : 'outside';
  return { message: { role: 'tool', toolCallId: part.toolCallId, text }, source };
}

async function boundOf(tx: TenantQuery, facts: Bindings, part: Part): Promise<Bound> {
  switch (part.ref) {
    case 'task':
      return taskMessage(facts, part);
    case 'correction':
      return await correctionMessage(tx, facts, part);
    case 'answer':
      return await answerMessage(tx, facts, part);
    default:
      return undefined;
  }
}

/** The turn made into its one field, with the strictest of its sources. */
export interface TurnField {
  readonly value: string;
  readonly source: FieldSource;
}

/** Step 2: each part bound to what the broker owns, under the call's locks; undefined is `PROVENANCE_UNBOUND`. */
export async function bindTurn(
  tx: TenantQuery,
  facts: Bindings,
  turn: Turn,
): Promise<TurnField | undefined> {
  const messages: Message[] = [];
  let source: FieldSource = 'business_internal';
  for (const part of turn.parts) {
    // Each part is read under the same locks, in order.
    // eslint-disable-next-line no-await-in-loop
    const bound = await boundOf(tx, facts, part);
    if (bound === undefined) return undefined;
    messages.push(bound.message);
    if (bound.source !== 'business_internal') source = bound.source;
  }
  return { value: JSON.stringify(messages), source };
}

export type RequestFields =
  | { readonly ok: true; readonly fields: readonly ResolvedField[] }
  | { readonly ok: false; readonly code: BrokerRefusal };

const MALFORMED = { ok: false, code: 'TURN_MALFORMED' } as const;

/**
 * The fields a call sends, as the broker acts on them: each resolved from its
 * row (S3), or the turn read, its ordinal checked against `place` (the
 * reserve's; the start, which already holds its place, passes none), bound
 * and made into the operation's one field. A turn is for an operation that
 * takes one, and only a turn is.
 */
export async function fieldsOf(
  tx: TenantQuery,
  request: ModelCallRequest,
  operation: ModelOperation,
  facts: Bindings,
  place?: number,
): Promise<RequestFields> {
  if ((operation.turn === true) !== (request.turn !== undefined)) return MALFORMED;
  if (request.turn === undefined) return resolveFields(request.fields, facts.source);
  const turn = readTurn(request.turn);
  if (turn === undefined) return MALFORMED;
  if (place !== undefined && turn.ordinal !== place)
    return { ok: false, code: 'TURN_ORDINAL_STALE' };
  const bound = await bindTurn(tx, facts, turn);
  if (bound === undefined) return { ok: false, code: 'PROVENANCE_UNBOUND' };
  if (!toolsKept(turn)) return MALFORMED;
  return { ok: true, fields: [{ name: 'turn', source: bound.source, value: bound.value }] };
}
