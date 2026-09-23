// SPDX-License-Identifier: AGPL-3.0-only
//
// The task record type, declared once, in the order the reservation fixes.
//
// A task is a built-in record type in fixed typed slots, and there is no
// physical tasks table (ADR 0037). So "the task type" is this list plus the
// rows the installer writes from it. The list is the only place the spine is
// stated, and the conformance set reads the database back against it, so a
// field that drifts from its classification is a diff a reviewer sees rather
// than a behaviour a caller discovers.
//
// The slot order is fixed slots 2.2, taken literally: `uuid_1` to `uuid_6`,
// `txt_1` to `txt_6`, `ts_1`, `ts_2`, `num_1`, `num_2`. Two fields sit outside
// that sixteen — `client_visible` and the party link — and migration 0006 says
// why they are here rather than deferred.
//
// The task-state type is `states.ts`. The two are one model and are two files
// because the per-file review cap is 400 hand-written lines and no waiver lifts
// it; the seam is the one the model already has, a record type each.

import type { FieldValueType, VisibilityClass, WriteMode } from '../records/fields.ts';

/** The task type's key. It never changes (CONTEXT.md, record type). */
export const TASK_TYPE_KEY = 'task';

export interface SpineField {
  readonly key: string;
  readonly label: string;
  readonly valueType: FieldValueType;
  /** Null means the field lives in `data`: readable and writable, never filterable. */
  readonly slot: string | null;
  readonly writeMode: WriteMode;
  /**
   * The operations that own a protected field; empty for one no operation
   * owns. More than one for `state`: completing, reopening and starting are
   * three commands over one field (minimum contract, 5.2). A list rather than
   * a string holding a list since 0009, because a reader who forgets to split
   * sees one operation named `task.complete task.reopen task.start`.
   */
  readonly owningOperations: readonly string[];
  /**
   * The operation that owns this field **when the write crosses an access
   * boundary**, while an ordinary write inside the caller's existing reach is
   * generic (specification, 14.2 point 5). Only `board` and `board_section`
   * carry one, and the engine does not refuse on it: the owning command reads
   * it. It exists because a contract row that has no home in the data is a
   * contract row the next part cannot honour.
   */
  readonly escalatingOperation: string | null;
  readonly searchable?: boolean;
  readonly uniqueValue?: boolean;
  readonly visibilityClass?: VisibilityClass;
}

/**
 * The spine, in reservation order.
 *
 * `write_mode` is minimum contract 5.2 as extended by the census (fixed slots
 * 4.1), carried unchanged. The three worth reading twice are `completed_at`,
 * `client_visible` and the party link: each looks like ordinary content and is
 * actually an evidence or access change, and each is the field a generic
 * editor offers first.
 */
export const TASK_SPINE: readonly SpineField[] = [
  {
    key: 'state',
    label: 'State',
    valueType: 'uuid',
    slot: 'uuid_1',
    writeMode: 'operation',
    // Three commands over one field. The refusal names all three, because a
    // caller told only "call task.complete" would be told the wrong thing
    // two-thirds of the time.
    owningOperations: ['task.complete', 'task.reopen', 'task.start'],
    escalatingOperation: null,
  },
  {
    key: 'assignee',
    label: 'Assignee',
    valueType: 'uuid',
    slot: 'uuid_2',
    writeMode: 'operation',
    owningOperations: ['task.assign'],
    escalatingOperation: null,
  },
  {
    key: 'delegate',
    label: 'Delegate',
    valueType: 'uuid',
    slot: 'uuid_3',
    writeMode: 'operation',
    owningOperations: ['task.assign'],
    escalatingOperation: null,
  },
  {
    key: 'parent',
    label: 'Parent',
    valueType: 'uuid',
    slot: 'uuid_4',
    writeMode: 'operation',
    owningOperations: ['task.reparent'],
    escalatingOperation: null,
  },
  {
    key: 'board',
    label: 'Board',
    valueType: 'uuid',
    slot: 'uuid_5',
    writeMode: 'generic',
    owningOperations: [],
    escalatingOperation: 'task.move',
  },
  {
    key: 'board_section',
    label: 'Board section',
    valueType: 'uuid',
    slot: 'uuid_6',
    writeMode: 'generic',
    owningOperations: [],
    escalatingOperation: 'task.move',
  },
  {
    // The party link a party-scoped grant resolves against. A generic write to
    // it silently changes who can see the task (fixed slots, 4.1).
    key: 'client',
    label: 'Client',
    valueType: 'uuid',
    slot: 'uuid_7',
    writeMode: 'operation',
    owningOperations: ['task.set_party'],
    escalatingOperation: null,
  },
  {
    key: 'key',
    label: 'Key',
    valueType: 'text',
    slot: 'txt_1',
    writeMode: 'system',
    owningOperations: [],
    escalatingOperation: null,
    uniqueValue: true,
  },
  {
    // Derived from the authenticated actor kind and the entry point, never
    // taken from a request body (ADR 0037:18).
    key: 'source',
    label: 'Source',
    valueType: 'text',
    slot: 'txt_2',
    writeMode: 'system',
    owningOperations: [],
    escalatingOperation: null,
  },
  {
    key: 'intake_state',
    label: 'Intake state',
    valueType: 'text',
    slot: 'txt_3',
    writeMode: 'operation',
    owningOperations: ['task.triage'],
    escalatingOperation: null,
  },
  {
    key: 'title',
    label: 'Title',
    valueType: 'text',
    slot: 'txt_4',
    writeMode: 'generic',
    owningOperations: [],
    escalatingOperation: null,
    searchable: true,
  },
  {
    // A stage is a lifecycle position, not a label: stage moves carried soft
    // gates in the legacy (fixed slots, 4.1).
    key: 'stage',
    label: 'Stage',
    valueType: 'text',
    slot: 'txt_5',
    writeMode: 'operation',
    owningOperations: ['task.set_stage'],
    escalatingOperation: null,
  },
  {
    key: 'lane',
    label: 'Lane',
    valueType: 'text',
    slot: 'txt_6',
    writeMode: 'generic',
    owningOperations: [],
    escalatingOperation: null,
  },
  {
    key: 'due',
    label: 'Due',
    valueType: 'timestamptz',
    slot: 'ts_1',
    writeMode: 'generic',
    owningOperations: [],
    escalatingOperation: null,
  },
  {
    // System, and with no owning operation, because no operation takes it as
    // an input: it is a projection of the current state's machine category
    // (specification, 14.1). `task.complete` sets it and `task.reopen` clears
    // it, both in the same transaction as their state write.
    key: 'completed_at',
    label: 'Completed at',
    valueType: 'timestamptz',
    slot: 'ts_2',
    writeMode: 'system',
    owningOperations: [],
    escalatingOperation: null,
  },
  {
    key: 'priority',
    label: 'Priority',
    valueType: 'numeric',
    slot: 'num_1',
    writeMode: 'generic',
    owningOperations: [],
    escalatingOperation: null,
  },
  {
    // Generic, as both landed contracts classify it, and still not accepted on
    // create: placement is the server's (specification, 14.2 point 3), and
    // re-ranking is `task.rank`, which takes neighbours rather than a number.
    key: 'board_rank',
    label: 'Board rank',
    valueType: 'numeric',
    slot: 'num_2',
    writeMode: 'generic',
    owningOperations: [],
    escalatingOperation: null,
  },
  {
    // The disclosure boundary. Promoting a task to client-visible is the same
    // act as promoting a team comment to client audience (fixed slots, 4.1),
    // and the legacy's `true` default is not carried.
    key: 'client_visible',
    label: 'Client visible',
    valueType: 'boolean',
    slot: 'bool_1',
    writeMode: 'operation',
    owningOperations: ['task.set_audience'],
    escalatingOperation: null,
  },
  {
    // Unslotted on purpose: long display text that no view filters, sorts or
    // groups on. A slot would buy nothing and cost an index.
    key: 'description',
    label: 'Description',
    valueType: 'text',
    slot: null,
    writeMode: 'generic',
    owningOperations: [],
    escalatingOperation: null,
  },
];

/**
 * The fields a generic write must never reach, named rather than derived, so
 * relaxing one is a visible diff (minimum contract, 5.3 assertion 2).
 */
export const PROTECTED_TASK_FIELDS: readonly string[] = [
  'assignee',
  'client',
  'client_visible',
  'completed_at',
  'delegate',
  'intake_state',
  'key',
  'parent',
  'source',
  'stage',
  'state',
];

/** The two fields that are generic ordinarily and an access change sometimes. */
export const CONDITIONAL_TASK_FIELDS: readonly string[] = ['board', 'board_section'];

/**
 * Fields the legacy carried on its task row that the new core does not carry
 * at all, asserted by name so re-adding one is a failure rather than a
 * migration. The run and the lease own machine lifecycle (specification, 14.4);
 * a clearance number cannot express the whole policy (decisions.md:24); and a
 * second coarse status is the thing 14.5 exists to prevent.
 */
export const FIELDS_NOT_CARRIED: readonly string[] = [
  'agent_state',
  'claimed_at',
  'claimed_by',
  'clearance',
  'current_run_id',
  'status',
  'status_label',
];

/** The slot each spine field is read out of, for the queries that need one. */
export function slotOf(fields: readonly SpineField[], key: string): string {
  const field = fields.find((candidate) => candidate.key === key);
  if (field?.slot === undefined || field.slot === null) {
    throw new Error(`slotOf: ${key} is not a slotted field`);
  }
  return field.slot;
}
