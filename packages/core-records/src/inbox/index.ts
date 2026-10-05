// SPDX-License-Identifier: AGPL-3.0-only
//
// The inbox's records: its items, who may read them, raising, mentions,
// clearing and the unattended read. The other packages reach them through the
// package index, which re-exports this file whole.

export { readInboxItems, countOwedItems, INBOX_HISTORY_PAGE, INBOX_HISTORY_SCAN } from './read.ts';
export {
  INBOX_REASONS,
  owes,
  toldAtOnce,
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
