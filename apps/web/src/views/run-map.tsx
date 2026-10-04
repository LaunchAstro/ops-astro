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
// carried to another grant or task: `RunProgress` is keyed by both, so another
// scope is a new map with its own read, and the held graph is keyed by scope
// besides. A read that settles without a graph (denied, unavailable) drops it,
// so a later re-read shows nothing until a read succeeds again.

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
  // Another grant or task: nothing held carries over.
  if (held.current?.scope !== props.scope) held.current = null;
  if (props.graph !== undefined) held.current = { scope: props.scope, graph: props.graph };
  // A read that settled without a graph (denied, unavailable): the held one goes.
  else if (!loading) held.current = null;
  const graph = props.graph ?? (loading ? held.current?.graph : undefined);
  // Drawn only from a read this page could read; the run section says why otherwise.
  if (graph === undefined) return null;
  return <ExecutionMap graph={graph} gates={gatesOf(props.proposals)} />;
}
