// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock's Team panel (MP-7-10): the people strip and the person's own
// availability, with the room below it where team chat sits (C71-D, C71-G).

import type { ReactElement } from 'react';
import type { AvailabilityChange, Teammate } from '../state/team.ts';
import type { OpenHow } from './gesture.ts';

export interface TeamPanelProps {
  /** Every member the reader works with, the reader included. */
  readonly people: readonly Teammate[];
  /** The reader's own person id. */
  readonly me: string;
  /** Where a teammate's work opens (Projects scoped to them). */
  readonly workHref: (personId: string) => string;
  readonly onOpenWork: (personId: string, how: OpenHow) => void;
  readonly onSetAvailability: (change: AvailabilityChange) => void;
}

export function TeamPanel(props: TeamPanelProps): ReactElement {
  void props;
  return <div className="tmc" />;
}
