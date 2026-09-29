// SPDX-License-Identifier: AGPL-3.0-only
//
// C2: live presence. Stub for the red run.

export type PresenceSide = 'staff' | 'client';

export interface PresenceSession {
  readonly sessionId: string;
  readonly personId: string;
  readonly name: string;
  readonly side: PresenceSide;
}

export interface PresenceView {
  readonly personId: string;
  readonly name: string;
  readonly state: 'viewing' | 'changing';
  readonly field: string | null;
}

export type PresenceChanged = (businessId: string, topic: string) => void;

export class PresenceBook {
  readonly changed: PresenceChanged;

  constructor(changed: PresenceChanged) {
    this.changed = changed;
  }

  join(_businessId: string, _topic: string, _session: PresenceSession): () => void {
    return () => {};
  }

  mark(_businessId: string, _topic: string, _sessionId: string, _field: string | null): boolean {
    return false;
  }

  seenBy(_businessId: string, _topic: string, _sessionId: string): readonly PresenceView[] {
    return [];
  }

  get held(): number {
    return 0;
  }
}
