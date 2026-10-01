// SPDX-License-Identifier: AGPL-3.0-only
//
// What `access.read` and `client.list` answer (C32), split out of `views.ts` when the main
// merge joined it past the product file limit. Types only, as there.

import type { Action } from '../../core-records/src/index.ts';
import type { PersonView } from './views.ts';

/** One permission in effect: an action on a collection, over the scope it reaches. */
export interface AccessPermission {
  readonly collection: string;
  readonly action: Action;
  /** `id` is null exactly at business scope; a client is a `party`. */
  readonly scope: { readonly kind: 'business' | 'party' | 'record'; readonly id: string | null };
}

/** One live grant row naming a person or their acting identity: what `access.revoke` takes. */
export interface AccessGrant extends AccessPermission {
  readonly grantId: string;
}

/**
 * A permission a person may use now, and whether the command path first asks
 * the money step-up (C59) for it: a recent second factor, or for a client a
 * recent sign-in. True exactly when `asksMoneyStepUp` is.
 */
export interface AccessPreview extends AccessPermission {
  readonly stepUp: boolean;
}

/**
 * A person on Team or Clients, with the preview of what they may do now and
 * the live grants behind it, each by id, so one can be revoked.
 */
export interface AccessPerson extends PersonView {
  readonly permissions: readonly AccessPreview[];
  readonly grants: readonly AccessGrant[];
}

/** An agent on a live delegation, under the person record it draws on. */
export interface AccessAgent {
  readonly agentActorId: string;
  readonly delegationId: string;
  readonly purpose: string;
  readonly person: PersonView;
  readonly expiresAt: string;
  /** Its delegation's narrowing of its person's grants, on the one record it is for. */
  readonly permissions: readonly AccessPermission[];
}

/**
 * `access.read`'s answer (C32). The three lists are one set of `people` rows:
 * Team is the assignee list, Clients the people without a membership who
 * stand on a live grant, and each agent names its person rather than copying it.
 */
export interface AccessReadResult {
  readonly ok: true;
  readonly team: readonly AccessPerson[];
  readonly clients: readonly AccessPerson[];
  readonly agents: readonly AccessAgent[];
  /** The business's client records, which a `party` scope in a preview names. */
  readonly clientRecords: readonly ClientView[];
}

/** One client record (C32): an organisation the business works for. */
export interface ClientView {
  readonly clientId: string;
  readonly name: string;
}

/** `client.list`'s answer: the clients the caller's live grants reach. */
export interface ClientListResult {
  readonly ok: true;
  readonly clients: readonly ClientView[];
}
