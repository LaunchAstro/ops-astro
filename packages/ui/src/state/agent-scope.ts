// SPDX-License-Identifier: AGPL-3.0-only
//
// What a run was allowed to touch, in the scope stamp's words (MP-6-4, DS-TASK-3).
//
// The stamp reads the lease's delegation and nothing else: the broker set it
// when the agent picked the work up, and no field a person edits on the task
// reaches it (R76). So the stamp's middle part is the delegation's purpose,
// never the task's work label, and the stamp offers no control.

import type { RunLineage, RunScope } from './run-projection.ts';

export type ScopeStamp =
  /** No lease has been taken on this lineage yet. */
  | { readonly kind: 'none' }
  /** A person holds the lease, under their own grants. */
  | { readonly kind: 'person'; readonly acquiredAt: string }
  | {
      readonly kind: 'agent';
      readonly acquiredAt: string;
      readonly delegation: NonNullable<RunScope['delegation']>;
      /** The one resource the delegation reaches, in words. */
      readonly reach: string;
      /** The purpose, read as words: the stamp's middle part. */
      readonly lane: string;
      /** The actions it carries: the clearance. */
      readonly clearance: string;
      readonly writes: boolean;
    };

/** The newest lease's scope on the lineage the pane shows. */
export function scopeStamp(lineage: RunLineage | undefined): ScopeStamp {
  const scope = lineage?.scopes?.at(-1);
  if (scope === undefined) return { kind: 'none' };
  const { delegation } = scope;
  if (delegation === null) return { kind: 'person', acquiredAt: scope.acquiredAt };
  return {
    kind: 'agent',
    acquiredAt: scope.acquiredAt,
    delegation,
    reach: delegation.scope.kind === 'record' ? 'this task only' : `the ${delegation.scope.kind}`,
    lane: delegation.purpose.replaceAll('_', ' '),
    clearance: delegation.actions.join(' · '),
    writes: delegation.actions.includes('write'),
  };
}
