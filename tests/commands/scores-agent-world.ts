// SPDX-License-Identifier: AGPL-3.0-only
//
// The shared world of the “MP-4-9 marks command for an agent” cases: the
// database, the people and the helpers they read, set up once per test file
// that imports it.
//
// A harness, not a suite: nothing here runs on its own.

import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';

import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';

import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';

import { agentWorld, type AgentWorld } from './agent-fixture.ts';

export const serverUrl: string | undefined = databaseUrlFromEnvironment();

export type Request = Parameters<typeof executeCommand>[4];

export const outcomeOf: (answer: CommandResult) =>
  | {
      code:
        | 'ACTOR_INACTIVE'
        | 'ACTUAL_EXPENDITURE_UNSUPPORTED'
        | 'ALREADY_TRASHED'
        | 'AUDIENCE_NOT_PERMITTED'
        | 'AUTHORITY_LOST'
        | 'AUTH_NO_AGENT_IDENTITY'
        | 'AUTH_NO_MEMBERSHIP'
        | 'AUTH_SESSION_EXPIRED'
        | 'AUTH_UNKNOWN_LOGIN'
        | 'BUDGET_EXHAUSTED'
        | 'BUDGET_UNAVAILABLE'
        | 'CAP_BINDING_MISMATCH'
        | 'CHANGE_ROUNDS_EXHAUSTED'
        | 'COMMAND_BODY_INVALID'
        | 'DECISION_STALE'
        | 'DELEGATION_ALREADY_LIVE'
        | 'DELEGATION_EXCLUDES_DECISION'
        | 'DELEGATION_EXCLUDES_INTAKE'
        | 'DELEGATION_EXCLUDES_OPERATION'
        | 'DELEGATION_EXPIRED'
        | 'DELEGATION_NARROWED'
        | 'DELEGATION_NOT_LIVE'
        | 'DELEGATION_OUT_OF_PURPOSE'
        | 'DELEGATION_REVOKED'
        | 'DELEGATION_WIDENS'
        | 'DEPENDENCY_NOT_LANDED'
        | 'EFFECT_NOT_DISPATCHED'
        | 'EFFECT_NOT_OBSERVED'
        | 'EFFECT_NOT_RECONCILABLE'
        | 'EVIDENCE_MISMATCH'
        | 'EXPECTED_REVISION_REQUIRED'
        | 'FIELD_NOT_GROUPABLE'
        | 'FIELD_NOT_SLOTTED'
        | 'FIELD_NOT_WRITABLE'
        | 'FIELD_UNKNOWN'
        | 'FIELD_VALUE_INVALID'
        | 'FOUR_EYES_REQUIRED'
        | 'GATE_ALREADY_DECIDED'
        | 'GATE_EXPIRED'
        | 'GATE_NOT_APPROVED'
        | 'GATE_NOT_FOUND'
        | 'GATE_PENDING'
        | 'GRANT_DEEPENS'
        | 'GRANT_WIDENS'
        | 'LEASE_EXPIRED'
        | 'LEASE_HELD'
        | 'LEASE_NOT_OWNED'
        | 'LIABILITY_NOT_UNKNOWN'
        | 'LINEAGE_NOT_ON_TASK'
        | 'LINEAGE_TERMINAL'
        | 'NOT_FOUND'
        | 'OPERATION_ID_REQUIRED'
        | 'OPERATION_ID_REUSED'
        | 'PARENT_TRASHED'
        | 'PLACEMENT_IS_DERIVED'
        | 'PRESET_FIELD_DUPLICATE'
        | 'PRESET_FIELD_UNCLASSIFIED'
        | 'PRESET_FIELD_UNPLACEABLE'
        | 'PRESET_TYPE_UNKNOWN'
        | 'PROPOSAL_SCOPE_EXCEEDED'
        | 'PROPOSAL_SUPERSEDED'
        | 'RESERVATION_NOT_CLAIMABLE'
        | 'RETENTION_CLASS_PROTECTED'
        | 'SCOPE_NOT_GRANTED'
        | 'SLOT_INDEX_ABSENT'
        | 'SLOT_RESERVED'
        | 'SLOT_TYPE_EXHAUSTED'
        | 'SLOT_UNKNOWN'
        | 'SOURCE_SPOOFED'
        | 'SUCCESSOR_OUT_OF_BOUNDS'
        | 'TASK_NOT_PICKABLE'
        | 'TRANSITION_NOT_PERMITTED'
        | 'TRANSITION_PROTECTED'
        | 'UNIQUE_VALUE_TAKEN'
        | 'VERSION_STALE'
        | 'VIEW_HOP_LIMIT'
        | 'WRONG_BUSINESS';
      names: readonly string[];
      applied?: never;
    }
  | { code?: never; names?: never; applied: boolean } = (answer: CommandResult) =>
  isCommandRefusal(answer) ? { code: answer.code, names: answer.names } : { applied: true };

export let world: AgentWorld;

export const revisionOf: (recordId: string) => Promise<number> = async (recordId: string) =>
  Number(
    (
      await world.db.admin.execute<{ readonly revision: string }>(
        `select revision::text as revision from public.records where business_id = $1 and id = $2`,
        [world.business, recordId],
      )
    )[0]?.revision,
  );

export async function setUp(): Promise<void> {
  world = await agentWorld('s', 'task-scores-agent');
}

export async function tearDown(): Promise<void> {
  await world?.drop();
}
