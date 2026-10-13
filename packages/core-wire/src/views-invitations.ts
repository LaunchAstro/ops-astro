// SPDX-License-Identifier: AGPL-3.0-only
//
// What `invitation.list` answers (C39-T): the business's team invitations for
// Settings ▸ Access. Types only, as in `views.ts`. No token and no token hash
// is ever part of it.

/** The roles an invitation names; an owner is never invited. */
export type InvitationRole = 'member' | 'admin';

/** An invitation's state; `expired` is derived from its lifetime while it is still pending. */
export type InvitationState = 'pending' | 'accepted' | 'revoked' | 'expired';

/** One invitation: who, which role, where it stands, when it was last sent and when it lapses. */
export interface InvitationView {
  readonly invitationId: string;
  readonly name: string;
  readonly address: string;
  readonly role: InvitationRole;
  readonly state: InvitationState;
  readonly createdAt: string;
  /** The last delivery the provider took, or null when none has been taken. */
  readonly sentAt: string | null;
  readonly expiresAt: string;
}

/** `invitation.list`'s answer, newest first. */
export interface InvitationListResult {
  readonly ok: true;
  readonly invitations: readonly InvitationView[];
}
