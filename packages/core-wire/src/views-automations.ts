// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Workflow triggers' read result (C33, C52-A), as it crosses the wire.
// Types only, beside `views.ts`, which is at its line cap.

/**
 * Each definition with its released versions, oldest first, and the
 * activations pinned to them. Definitions carry no client, so the registry is
 * the business's and nothing in it is filtered by client.
 */
export interface AutomationRegistryResult {
  readonly ok: true;
  readonly definitions: readonly AutomationDefinitionView[];
}

export interface AutomationDefinitionView {
  readonly id: string;
  readonly kind: 'skill' | 'automation';
  readonly name: string;
  readonly versions: readonly DefinitionVersionView[];
  readonly activations: readonly ActivationView[];
}

export interface DefinitionVersionView {
  readonly id: string;
  readonly number: number;
  readonly contentDigest: string;
  readonly contentSize: number;
  readonly modes: readonly ('manual' | 'scheduled' | 'event')[];
  readonly releasedBy: string;
  readonly releasedAt: string;
}

export interface ActivationView {
  readonly id: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly mode: 'manual' | 'scheduled' | 'event';
  readonly everyMinutes: number | null;
  readonly eventKind: string | null;
  readonly enabled: boolean;
  readonly changedBy: string;
  readonly changedAt: string;
  readonly revision: number;
  /** The standing approval the activation names (C52-A), revoked or not, or null. */
  readonly approval: StandingApprovalView | null;
}

/** An adoption of the pinned version: who decided it, and whether it is revoked. */
export interface StandingApprovalView {
  readonly id: string;
  readonly versionId: string;
  readonly act: 'adopted' | 'rolled_back';
  readonly decidedBy: string;
  readonly revoked: boolean;
}

/**
 * One activation's history (`automation.history`): its occurrences and the
 * changes people made to it, newest first, 50 a page. `next` is the cursor
 * that reads the page after this one, or null when nothing older is left.
 */
export interface AutomationHistoryResult {
  readonly ok: true;
  readonly entries: readonly AutomationHistoryEntry[];
  readonly next: string | null;
}

export type AutomationHistoryEntry = OccurrenceHistoryEntry | ChangeHistoryEntry;

/** What fired or was refused: a due time or an event, never the event's own id. */
export interface OccurrenceHistoryEntry {
  readonly kind: 'occurrence';
  readonly id: string;
  readonly at: string;
  readonly cause:
    { readonly kind: 'scheduled'; readonly dueAt: string } | { readonly kind: 'event' };
  /** The occurrence's outcome code (`approved`, `no_standing_approval`, ...), worded by the page. */
  readonly outcome: string;
  /** What dispatch found, or null when nothing was dispatched. */
  readonly dispatch: string | null;
  readonly runId: string | null;
}

/** A change a person made: the command, and the actor who sent it. */
export interface ChangeHistoryEntry {
  readonly kind: 'change';
  readonly id: string;
  readonly at: string;
  readonly command: string;
  readonly actorId: string;
  readonly actorKind: string | null;
  readonly actorName: string | null;
}
