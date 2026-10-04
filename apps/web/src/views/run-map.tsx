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
import type {
  ExecutionGraph,
  ProposalView,
  TaskExecution,
} from '../../../../packages/core-wire/src/index.ts';

/**
 * The gates the map may draw. A superseded version's gate is history: it
 * neither asks nor authorises (pickup's approvalCurrent), and the task read
 * can say so before the run's own re-read does, so its gate is left out here.
 */
export function gatesOf(proposals: readonly ProposalView[]): readonly MapGate[] {
  return proposals.flatMap((lineage) =>
    lineage.versions.flatMap((version) =>
      version.runId === null || version.gate === null || version.supersededAt !== null
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

type Fields = Readonly<Record<string, unknown>>;

const isFields = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isTextOrNull = (value: unknown): boolean => value === null || isText(value);
const isMinor = (value: unknown): boolean => value === null || Number.isSafeInteger(value);
const isTexts = (value: unknown): boolean =>
  Array.isArray(value) && value.every((each) => isText(each));

function isObserved(value: unknown): boolean {
  if (!isFields(value)) return false;
  const { whoseMove, lease } = value;
  return (
    isText(value['condition']) &&
    isText(value['runState']) &&
    isTextOrNull(value['outcome']) &&
    isTextOrNull(value['fault']) &&
    (whoseMove === null ||
      (isFields(whoseMove) && isText(whoseMove['kind']) && isTextOrNull(whoseMove['actorId']))) &&
    (lease === null || (isFields(lease) && isText(lease['state']) && isText(lease['expiresAt']))) &&
    typeof value['effectObserved'] === 'boolean' &&
    isMinor(value['heldMinor']) &&
    isMinor(value['spentMinor']) &&
    isText(value['currency'])
  );
}

function isNode(value: unknown): boolean {
  if (!isFields(value)) return false;
  const { planned } = value;
  return (
    isText(value['nodeId']) &&
    isText(value['condition']) &&
    (planned === null ||
      (isFields(planned) && isText(planned['key']) && isText(planned['title']))) &&
    isObserved(value['observed'])
  );
}

function isStep(value: unknown): boolean {
  return (
    isFields(value) &&
    isText(value['key']) &&
    isText(value['title']) &&
    isTexts(value['after']) &&
    isTexts(value['runIds'])
  );
}

/**
 * Whether a successful answer's graph has every field the map and the run
 * list read, all the way down. A graph that does not is a section error the
 * run section says, never a drawing that throws in render (MP-6-3).
 */
export function isExecutionGraph(value: unknown): value is ExecutionGraph {
  if (!isFields(value)) return false;
  const { steps, nodes } = value;
  return (
    (value['plan'] === 'bound' || value['plan'] === 'unbound') &&
    (steps === undefined || (Array.isArray(steps) && steps.every((each) => isStep(each)))) &&
    Array.isArray(nodes) &&
    nodes.every((each) => isNode(each))
  );
}
