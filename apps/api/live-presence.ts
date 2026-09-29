// SPDX-License-Identifier: AGPL-3.0-only
//
// C2 on the live channel. Stub for the red run.

import type { PresenceSession, PresenceView } from './presence.ts';

export interface LivePresence {
  seat(businessId: string, taskId: string, session: PresenceSession, heard: () => void): () => void;
  mark(
    businessId: string,
    taskId: string,
    seatId: string,
    personId: string,
    field: string | null,
  ): boolean;
  seenBy(
    businessId: string,
    taskId: string,
    seatId: string,
    personId: string,
  ): readonly PresenceView[] | undefined;
  readonly held: number;
}

export function createLivePresence(): LivePresence {
  return {
    seat: () => () => {},
    mark: () => false,
    seenBy: () => undefined,
    held: 0,
  };
}
