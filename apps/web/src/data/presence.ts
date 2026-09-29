// SPDX-License-Identifier: AGPL-3.0-only
//
// C2 on the page: who else is on this task, read from the presence book
// through the tab's own seat.

import type { OperationsClient, PresenceView } from '../operations/client.ts';

export type { PresenceView };

export interface Presence {
  readonly seen: readonly PresenceView[];
  /** The field this tab is changing, or null when it stops. */
  mark(field: string | null): void;
}

export function usePresence(_client: OperationsClient, _topic: string | null): Presence {
  return { seen: [], mark: () => {} };
}
