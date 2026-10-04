// SPDX-License-Identifier: AGPL-3.0-only
//
// The execution map on the task page (MP-6-3), from the run section's own
// `task.execution` read and the gates of `task.read`'s proposals the page
// already holds, so no second read.
//
// **Live without a reload.** The page's one live channel re-reads the task,
// and each new task read re-reads the run; while that re-read is in flight the
// map keeps the last graph it drew for this grant and task, so a step that
// completes moves the map in place and the selection stays. A graph is never
// carried to another grant or task: the held one is keyed by the scope it was
// read under, and an answer read under another scope is neither drawn nor
// held. A read that settles without a graph (denied, unavailable) drops it, so
// a later re-read shows nothing until a read succeeds again.

import { useRef, type ReactElement } from 'react';
import { ExecutionMap, type MapGate } from '@launchastro/ui';
import type { ProposalView, TaskExecution } from '../../../../packages/core-wire/src/index.ts';

export function gatesOf(proposals: readonly ProposalView[]): readonly MapGate[] {
  return proposals.flatMap((lineage) =>
    lineage.versions.flatMap((version) =>
      version.runId === null || version.gate === null
        ? []
        : [
            {
              runId: version.runId,
              state: version.gate.state,
              version: version.version,
              digest: version.gate.payloadDigest,
            },
          ],
    ),
  );
}

/**
 * The grant and task a read's answer belongs to. Until `useRead`'s effect
 * starts the new read, a changed grant or task still hands back the old
 * answer, so each answer keeps the scope of the render that first saw it.
 */
function useScopeOf(answer: unknown, scope: string): string {
  const under = useRef({ answer, scope });
  if (under.current.answer !== answer) under.current = { answer, scope };
  return under.current.scope;
}

export function RunMap(props: {
  /** The graph of a read this page could read, or undefined. */
  readonly graph: TaskExecution['graph'] | undefined;
  /** The run's read the graph came from; `loading` while it is read again. */
  readonly read: { readonly outcome: string };
  /** The grant and task the page shows now. */
  readonly scope: string;
  readonly proposals: readonly ProposalView[];
}): ReactElement | null {
  const held = useRef<{ readonly scope: string; readonly graph: TaskExecution['graph'] } | null>(
    null,
  );
  const loading = props.read.outcome === 'loading';
  const current = useScopeOf(props.read, props.scope) === props.scope;
  // Another grant or task: nothing held carries over.
  if (held.current?.scope !== props.scope) held.current = null;
  if (current && props.graph !== undefined)
    held.current = { scope: props.scope, graph: props.graph };
  // A read that settled without a graph (denied, unavailable): the held one goes.
  else if (current && !loading) held.current = null;
  const graph = current ? (props.graph ?? (loading ? held.current?.graph : undefined)) : undefined;
  // Drawn only from a read this page could read; the run section says why otherwise.
  if (graph === undefined) return null;
  return <ExecutionMap graph={graph} gates={gatesOf(props.proposals)} />;
}
