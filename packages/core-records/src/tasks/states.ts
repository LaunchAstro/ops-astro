// SPDX-License-Identifier: AGPL-3.0-only
//
// The task-state record type: the only status the core knows.
//
// `state` is a link to a record of this type, and this type carries the machine
// category, so there is no `status` column, no dual write and no derived coarse
// field anywhere (specification, 14.5). Removing the coarse path removes no
// capability — it moves the coarseness into data, where a preset changes it
// without a migration.
//
// It is a separate file from `spine.ts` for the reason 0005 is separate from
// 0004: the per-file review cap is 400 hand-written lines, no waiver lifts it,
// and the seam is the one the model already has.

import type { SpineField } from './spine.ts';

/** The state type's key. It never changes (CONTEXT.md, record type). */
export const TASK_STATE_TYPE_KEY = 'task_state';

/**
 * The machine-readable category every task state carries, so an agent can ask
 * "is this done?" without knowing an installation's own status names
 * (specification, 14.5). It is a closed set of five and there is no sixth.
 */
export type MachineCategory = 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled';

export const MACHINE_CATEGORIES: readonly MachineCategory[] = [
  'backlog',
  'unstarted',
  'started',
  'completed',
  'cancelled',
];

export interface TaskStateSeed {
  readonly key: string;
  readonly label: string;
  readonly machineCategory: MachineCategory;
  readonly position: number;
}

/**
 * The legacy's five status words, seeded per install.
 *
 * They are the Hub's own, recorded verbatim at [ADR 0011:30]: Needs review,
 * Active, Waiting on client, On hold, Complete — "preset data mapped onto the
 * five machine categories, never core states". Specification 14.5 point 2 says
 * they ship as preset seed rows carrying a category and a label, so that is
 * what this is. The label is a mutable display name and the key is the stable
 * identifier; separating the two is what `status_label` was groping towards.
 *
 * **The mapping is a modelling call and the five words do not cover the five
 * categories.** Complete and Active are obvious. Needs review is unstarted
 * rather than backlog because it is in the workspace awaiting its first act;
 * On hold is backlog because it has been pushed out of the flow; Waiting on
 * client is started because the work has begun and is blocked on somebody
 * else. **Nothing maps to `cancelled`** — the Hub had no cancelled word — so an
 * installation seeded from the legacy set cannot reach that category until a
 * preset adds a state for it. That is recorded rather than papered over with an
 * invented sixth row.
 */
export const TASK_STATE_SEED: readonly TaskStateSeed[] = [
  { key: 'needs_review', label: 'Needs review', machineCategory: 'unstarted', position: 1000 },
  { key: 'active', label: 'Active', machineCategory: 'started', position: 2000 },
  {
    key: 'waiting_on_client',
    label: 'Waiting on client',
    machineCategory: 'started',
    position: 3000,
  },
  { key: 'on_hold', label: 'On hold', machineCategory: 'backlog', position: 4000 },
  { key: 'complete', label: 'Complete', machineCategory: 'completed', position: 5000 },
];

/**
 * The state record's own fields.
 *
 * They take reserved slots, which a core field may do and a preset field may
 * not: the reservation holds against a preset sync, and T1d's conformance set
 * spells that out as "a reserved slot holds a core field only". The
 * alternative — free slots — would need three new indexes and would spend
 * three of the twelve preset text slots on a core type.
 *
 * `key` and `machine_category` are `system`: no command takes either as a
 * field value, and re-categorising a state through a generic edit is how a
 * board silently stops knowing what "done" means. `label` and `position` are
 * ordinary configuration.
 */
export const TASK_STATE_FIELDS: readonly SpineField[] = [
  {
    key: 'key',
    label: 'Key',
    valueType: 'text',
    slot: 'txt_1',
    writeMode: 'system',
    owningOperation: null,
    escalatingOperation: null,
    uniqueValue: true,
  },
  {
    key: 'machine_category',
    label: 'Machine category',
    valueType: 'text',
    slot: 'txt_2',
    writeMode: 'system',
    owningOperation: null,
    escalatingOperation: null,
  },
  {
    key: 'label',
    label: 'Label',
    valueType: 'text',
    slot: null,
    writeMode: 'generic',
    owningOperation: null,
    escalatingOperation: null,
  },
  {
    key: 'position',
    label: 'Position',
    valueType: 'numeric',
    slot: 'num_1',
    writeMode: 'generic',
    owningOperation: null,
    escalatingOperation: null,
  },
];
