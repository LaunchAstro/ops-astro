// SPDX-License-Identifier: AGPL-3.0-only
//
// The one counting rule for a task's Team and Agent perspectives (MP-4-3),
// read by the task page and the dock task panel alike (D-07 not copied). No
// markup here, so a server-side test can hold a real read to it. The reasons
// are at the head of `Perspectives.tsx`.

import type { ProposalView, StepView } from '../../../../../packages/core-wire/src/index.ts';

export type Perspective = 'team' | 'agent';

/** What the Team count reads of a subtask. */
export interface StepMark {
  readonly done: boolean;
  readonly retired: boolean;
}

/** What the Team count reads of each step the task read carries (MP-4-4). */
export function stepMarks(steps: readonly StepView[]): readonly StepMark[] {
  return steps.map((step) => ({ done: step.done, retired: step.archived !== null }));
}

export interface PerspectiveCounts {
  readonly team: number;
  readonly agent: number;
  /** What the Agent badge says it is counting; empty when it counts nothing. */
  readonly agentTitle: string;
}

const openGates = (proposals: readonly ProposalView[]): number =>
  proposals.filter((proposal) => {
    const live = proposal.versions[0];
    return (
      live !== undefined &&
      live.supersededAt === null &&
      live.gate !== null &&
      live.gate.state === 'pending' &&
      !live.gate.expired
    );
  }).length;

export function perspectiveCounts(input: {
  readonly steps: readonly StepMark[];
  readonly proposals: readonly ProposalView[];
  readonly stagedOutput: boolean;
}): PerspectiveCounts {
  const team = input.steps.filter((step) => !step.retired && !step.done).length;
  const gates = openGates(input.proposals);
  if (gates > 0) {
    return {
      team,
      agent: gates,
      agentTitle: `${gates} open ${gates === 1 ? 'gate' : 'gates'} waiting on you`,
    };
  }
  return input.stagedOutput
    ? { team, agent: 1, agentTitle: 'Staged output waiting on you' }
    : { team, agent: 0, agentTitle: '' };
}
