// SPDX-License-Identifier: AGPL-3.0-only
//
// A wayfinder map as the wire carries it (WF-1, WF-2): its sections, tickets
// and versions, and its frontier and fog. Split from `views.ts` to keep that
// file under the 1,000-line cap. Types only, like `views.ts`.

/** One component of a map's body (WF-1): its own id, its kind and its text. */
export interface MapComponentView {
  readonly id: string;
  readonly kind: 'destination' | 'notes' | 'fog' | 'out_of_scope';
  readonly text: string;
  /** An Out of scope item's closed ticket, where one exists. */
  readonly ticketId: string | null;
}

/** A map as its view reads it: the task, its sections, its tickets and its versions. */
export interface MapView {
  readonly id: string;
  readonly key: string | null;
  readonly title: string | null;
  readonly type: 'map';
  readonly owner: string | null;
  readonly client: string | null;
  readonly version: number;
  /** The map record's revision, which an edit sends back as `expectedRevision`. */
  readonly revision: number;
  readonly destination: MapComponentView | null;
  readonly notes: MapComponentView | null;
  readonly fog: readonly MapComponentView[];
  readonly outOfScope: readonly MapComponentView[];
  /** Rendered from resolved tickets in closing order; stored once, on each ticket. */
  readonly decisions: readonly {
    readonly ticketId: string;
    readonly key: string | null;
    readonly title: string | null;
    readonly gist: string | null;
    readonly closedAt: string | null;
  }[];
  readonly tickets: readonly {
    readonly id: string;
    readonly key: string | null;
    readonly title: string | null;
    readonly type: string;
    readonly state: string | null;
    /** The ticket record's revision, which a write to it sends back. */
    readonly revision: number;
    /** The tickets of this map that block it. */
    readonly blockedBy: readonly string[];
  }[];
  readonly versions: readonly {
    readonly version: number;
    readonly changed: readonly string[];
    readonly actorId: string;
    readonly at: string;
  }[];
}

export interface MapViewResult {
  readonly ok: true;
  readonly map: MapView;
}

/** A map's frontier and fog (WF-2): each from its read model, in order. */
export interface MapFrontierResult {
  readonly ok: true;
  readonly frontier: readonly {
    readonly id: string;
    readonly key: string | null;
    readonly title: string | null;
    readonly type: string;
  }[];
  readonly fog: readonly { readonly id: string; readonly text: string }[];
}
