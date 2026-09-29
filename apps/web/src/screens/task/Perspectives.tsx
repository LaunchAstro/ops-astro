// SPDX-License-Identifier: AGPL-3.0-only
//
// The Team and Agent perspectives of one task (MP-4-3). A typed stub: the
// tests are written against it first and fail on their answers.

import type { ReactElement, ReactNode } from 'react';
import type { ProposalView } from '../../../../../packages/core-wire/src/index.ts';

export type Perspective = 'team' | 'agent';

export interface StepMark {
  readonly done: boolean;
  readonly retired: boolean;
}

export interface PerspectiveCounts {
  readonly team: number;
  readonly agent: number;
  readonly agentTitle: string;
}

export function perspectiveCounts(_input: {
  readonly steps: readonly StepMark[];
  readonly proposals: readonly ProposalView[];
  readonly stagedOutput: boolean;
}): PerspectiveCounts {
  return { team: 0, agent: 0, agentTitle: '' };
}

export type PanelDoor = 'open' | 'tick' | 'add-first' | 'log' | 'timer';

export function PanelDoorButton(_props: {
  readonly door: PanelDoor;
  readonly onOpenPanel: ((door: PanelDoor) => void) | undefined;
}): ReactElement | null {
  return null;
}

export function Perspectives(_props: {
  readonly counts: PerspectiveCounts;
  readonly selected: Perspective;
  readonly onSelect: (next: Perspective) => void;
  readonly team: ReactNode;
  readonly agent: ReactNode;
}): ReactElement | null {
  return null;
}
