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
      /** The actions it carries on the task's own collection: the clearance. */
      readonly clearance: string;
      readonly writes: boolean;
      /** Every pair it carries, by collection, in words. */
      readonly reaches: string;
    };

type Pair = NonNullable<RunScope['delegation']>['pairs'][number];

/** The grant model's order, so a clearance reads the same however the pairs were stored. */
const ACTION_ORDER = ['read', 'comment', 'write', 'assign', 'share', 'manage'];

/** The task's own collection first, then the rest by name; each one's actions in the model's order. */
function ordered(pairs: readonly Pair[], own: string | undefined): readonly Pair[] {
  const rank = (pair: Pair): string =>
    `${pair.collection === own ? 0 : 1}${pair.collection}:${ACTION_ORDER.indexOf(pair.action)}`;
  return pairs.toSorted((a, b) => rank(a).localeCompare(rank(b)));
}

/** `task (read, comment, write) and run (write)`: each collection with its actions. */
function inWords(pairs: readonly Pair[]): string {
  const groups = new Map<string, string[]>();
  for (const { collection, action } of pairs) {
    groups.set(collection, [...(groups.get(collection) ?? []), action]);
  }
  return [...groups]
    .map(([collection, actions]) => `${collection} (${actions.join(', ')})`)
    .join(' and ');
}

/** The newest lease's scope on the lineage the pane shows. */
export function scopeStamp(lineage: RunLineage | undefined): ScopeStamp {
  const scope = lineage?.scopes?.at(-1);
  if (scope === undefined) return { kind: 'none' };
  const { delegation } = scope;
  if (delegation === null) return { kind: 'person', acquiredAt: scope.acquiredAt };
  // The task's own collection is the one the purpose reads, as the server's
  // purpose check takes it (`agent-authority.ts`); `run:write` beside it is
  // named in `reaches`, never folded into this clearance.
  const own = delegation.pairs.find((pair) => pair.action === 'read')?.collection;
  const pairs = ordered(delegation.pairs, own);
  const actions = pairs.filter((pair) => pair.collection === own).map((pair) => pair.action);
  return {
    kind: 'agent',
    acquiredAt: scope.acquiredAt,
    delegation,
    reach: delegation.scope.kind === 'record' ? 'this task only' : `the ${delegation.scope.kind}`,
    lane: delegation.purpose.replaceAll('_', ' '),
    clearance: actions.join(' · '),
    writes: actions.includes('write'),
    reaches: inWords(pairs),
  };
}
