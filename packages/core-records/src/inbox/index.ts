// SPDX-License-Identifier: AGPL-3.0-only
//
// The inbox's way into the records package: reading, raising and clearing
// inbox items, the access check, mentions and the unattended list. The
// package's index re-exports this list whole.

export { readInboxItems, countOwedItems } from './read.ts';
export {
  INBOX_REASONS,
  raiseInboxItem,
  stampSeen,
  recordDeliveryAttempt,
  type DeliveryState,
  type InboxAccess,
  type InboxFactKind,
  type InboxItem,
  type InboxAlert,
  type InboxReason,
  type InboxWorkState,
} from './items.ts';
export { INTERNAL_ROLE_KEYS, readScopes, taskAccess } from './access.ts';
export {
  raiseAssignment,
  raiseDecision,
  raiseEscalation,
  raiseIncident,
  raiseRunSettled,
} from './raise.ts';
export { raiseMentions, readMentions, seenBy, type Mentioned } from './mentions.ts';
export { clearDecision, withdrawEndedGates } from './clear.ts';
export { readUnattended, type UnattendedItem } from './unattended.ts';
