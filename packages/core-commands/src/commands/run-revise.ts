// SPDX-License-Identifier: AGPL-3.0-only
//
// `run.revise_state`: what the run knows so far, recorded as its next state
// revision under its worker lease (MP-6-2, CS-16.4). The operands are read and
// refused here, once for both entries: every list whole and every line in its
// exact shape, never trimmed or skipped. The runtime's `reviseState` locks the
// lease, re-checks the caller and `run:write` at one instant, then numbers and
// writes. Neither entry takes its actor from the body.

import type { Subject, TenantQuery } from '../../../core-records/src/index.ts';
import {
  NOT_OWNED_FIX,
  leaseReason,
  reviseState,
  type Knowledge,
  type RevisionRequest,
} from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { isIdentifier } from './operands.ts';
import { refuseCommand } from './refusal.ts';
import { storableText } from './values.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { personClaimant, type AgentClaimant } from './tasks-claimant.ts';

const KEY_LIMIT = 120;
const TEXT_LIMIT = 500;
const LINES_LIMIT = 40;

export interface RevisionFields {
  readonly leaseId: unknown;
  readonly fence: unknown;
  readonly step?: unknown;
  readonly valid: unknown;
  readonly unknowns: unknown;
  readonly stale: unknown;
}

type Caller =
  | { readonly claimant: 'agent'; readonly holderActorId: string; readonly delegationId: string }
  | {
      readonly claimant: 'person';
      readonly holderActorId: string;
      readonly subjects: readonly Subject[];
      readonly collection: string;
    };

/**
 * Non-blank, bounded, and storable: a NUL or an unpaired surrogate inside a
 * list line reaches no door check (`prepare.ts` reads the top-level operand),
 * and jsonb refuses both, so it is refused here rather than raised on.
 */
const text = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= limit && storableText(value);

/** A line of exactly these keys, each a bounded, non-blank string. */
const lineOf =
  (limits: Readonly<Record<string, number>>) =>
  (value: unknown): boolean => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    const wanted = Object.keys(limits);
    return (
      keys.length === wanted.length &&
      wanted.every((key) => text((value as Record<string, unknown>)[key], limits[key] ?? 0))
    );
  };

const listOf = (value: unknown, line: (one: unknown) => boolean): boolean =>
  Array.isArray(value) && value.length <= LINES_LIMIT && value.every((one) => line(one));

/** The fields that are not a knowledge of the documented shape. */
function invalidOf(fields: RevisionFields): readonly string[] {
  return [
    ...(fields.step === undefined || fields.step === null || text(fields.step, KEY_LIMIT)
      ? []
      : ['step']),
    ...(listOf(fields.valid, lineOf({ k: KEY_LIMIT, v: TEXT_LIMIT })) ? [] : ['valid']),
    ...(listOf(fields.unknowns, (one) => text(one, TEXT_LIMIT)) ? [] : ['unknowns']),
    ...(listOf(fields.stale, lineOf({ k: KEY_LIMIT, why: TEXT_LIMIT })) ? [] : ['stale']),
    ...(typeof fields.fence === 'number' && Number.isSafeInteger(fields.fence) ? [] : ['fence']),
  ];
}

async function reviseAs(
  tx: TenantQuery,
  fields: RevisionFields,
  caller: Caller,
): Promise<HandlerOutcome> {
  const invalid = invalidOf(fields);
  if (invalid.length > 0) {
    return refused(
      refuseCommand('FIELD_VALUE_INVALID', invalid, [
        `Give valid as {k, v} lines, unknowns as text lines and stale as {k, why} lines, at most ${String(LINES_LIMIT)} each, keys up to ${String(KEY_LIMIT)} characters and text up to ${String(TEXT_LIMIT)}, a step of up to ${String(KEY_LIMIT)} if any, and the fence the pickup handed back.`,
      ]),
    );
  }
  if (!isIdentifier(fields.leaseId)) {
    return refused(
      refuseCommand('LEASE_NOT_OWNED', [], [leaseReason('not_owned'), NOT_OWNED_FIX.revise]),
    );
  }
  const knowledge = fields as unknown as Knowledge;
  const result = await reviseState(tx, {
    ...caller,
    leaseId: fields.leaseId,
    fence: fields.fence as number,
    step: typeof fields.step === 'string' ? fields.step : null,
    valid: knowledge.valid.map(({ k, v }) => ({ k, v })),
    unknowns: [...knowledge.unknowns],
    stale: knowledge.stale.map(({ k, why }) => ({ k, why })),
  } as RevisionRequest);
  if (!result.ok) return refused(result.refusal);
  return applied(result.value.taskId, null, {
    revisionId: result.value.revisionId,
    runId: result.value.runId,
    version: result.value.revision,
  });
}

/** A person revises the state of the run their own pickup took. */
export async function reviseOwnLease(
  tx: TenantQuery,
  context: CommandContext,
  fields: RevisionFields,
): Promise<HandlerOutcome> {
  const person = personClaimant(context);
  return await reviseAs(tx, fields, {
    claimant: 'person',
    holderActorId: person.actorId,
    subjects: person.subjects,
    collection: person.collection,
  });
}

/** The agent revises its run's state under its own lease and the delegation it presented. */
export async function reviseLease(
  tx: TenantQuery,
  fields: RevisionFields,
  agent: AgentClaimant,
  delegationId: string,
): Promise<HandlerOutcome> {
  return await reviseAs(tx, fields, {
    claimant: 'agent',
    holderActorId: agent.actorId,
    delegationId,
  });
}
