// SPDX-License-Identifier: AGPL-3.0-only
//
// The credential broker's custody and egress (ADR 0028, AW-01). Custody runs
// as its own process, holds every provider credential, and is the only place
// a model call leaves the machine. The broker's process holds a handle on it
// and never a credential.

export {
  mayCarry,
  parseCredentials,
  type CarryContext,
  type CarryRefusal,
  type CredentialKind,
  type CredentialRefusal,
  type StorableKind,
  type StoredCredential,
} from './credentials.ts';
export {
  parseDestinations,
  type Destination,
  type DestinationRefusal,
  type Outbound,
  type OutboundFault,
  type OutboundRequest,
} from './egress.ts';
export { startCustody, type Custody, type CustodyConfig, type CustodyOutcome } from './custody.ts';
export {
  callModelInConversation,
  type ConversationCallRequest,
  type ConversationScope,
} from './broker-conversation.ts';
export {
  EMAIL_OPERATION,
  sendInboxEmail,
  type EmailRefusal,
  type EmailResult,
  type MailSettings,
} from './broker-email.ts';
export { landEmailEvent, type EmailHookOutcome } from './broker-email-hook.ts';
export { tellCommentClients } from './broker-email-mention.ts';
export {
  callModelForPlanning,
  PLANNING_CAP_DEFAULT,
  readPlanningAllowance,
  readPlanningCap,
  type PlanningAllowance,
  type PlanningCapView,
} from './broker-planning.ts';
export {
  callModel,
  promptCopyRegistered,
  registerPromptCopy,
  reserveModelCall,
  sendReservedCall,
  sweepModelCalls,
  type AuditNote,
  type BoundField,
  type Broker,
  type BrokerRefusal,
  type BrokerRoute,
  type ClaimedField,
  type ModelCaller,
  type ModelCallField,
  type ModelCallRequest,
  type ModelCallResult,
  type ProviderAdapter,
  type Reservation,
  type ResolvedField,
  type ReservedCall,
  type ReserveRefusal,
} from './broker.ts';
