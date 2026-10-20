// SPDX-License-Identifier: AGPL-3.0-only
//
// The credential broker's custody and egress (ADR 0028, AW-01). Custody runs
// as its own process, holds every provider credential, and is the only place
// a model call leaves the machine. The broker's process holds a handle on it
// and never a credential.

export {
  carriesLocally,
  carriesOnPlan,
  LOCAL_SESSION_PROVIDER,
  mayCarry,
  PLAN_PROVIDER,
  type CarryContext,
  type CarryRefusal,
} from './carry-rule.ts';
export {
  parseCredentials,
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
export { routeTemplate, siteCustody, siteDestination } from './site-custody.ts';
export { onThisMachine, startLoopbackMockCustody } from './email-mock-custody.ts';
export { custodySenderSource, type DomainRead } from './email-sender-custody.ts';
export { stopAtBudget, stopWords, type BudgetStopped } from './broker-wait.ts';
export { recordStop, retireAttempt, type StoppedAs } from './broker-stop.ts';
export { giveBack, giveBackReleased } from './broker-give-back.ts';
export { setLoginPassword, type LoginPasswordSet } from './broker-login-password.ts';
export {
  ENROL_PATH,
  INVITATION_SEND_ACTS,
  sendInvitation,
  sendOwedInvitation,
  type InvitationSendRefusal,
  type InvitationSendResult,
} from './broker-invitation.ts';
export { deliverAuthMessage, type AuthMessageOutcome } from './broker-auth-email.ts';
export { callModelInConversation } from './broker-priced.ts';
export type { ConversationCallRequest, ConversationScope } from './broker-conversation-types.ts';
export type { PaidCaller, PaidSeams } from './broker-types.ts';
export { PLANNING_CAP_DEFAULT } from './broker-hold.ts';
export { readPage } from './broker-task.ts';
export { ownersOwn } from './broker-sources.ts';
export { planHolds, type PlanAsk } from './broker-conversation-plan.ts';
export {
  callModelForPlanning,
  readPlanningAllowance,
  readPlanningCap,
  type PlanningAllowance,
  type PlanningCapView,
} from './broker-planning.ts';
export {
  EMAIL_OPERATION,
  sendInboxEmail,
  type EmailRefusal,
  type EmailResult,
  type MailSettings,
} from './broker-email.ts';
export { fromVerifiedSender } from './broker-email-route.ts';
export { landEmailEvent, type EmailHookOutcome } from './broker-email-hook.ts';
export { tellCommentClients } from './broker-email-mention.ts';
export {
  emailAtOnce,
  emailDailyBatch,
  type BatchResult,
  type EmailChoice,
  type EmailPreferences,
  type EmailTiming,
} from './email-timing.ts';
export {
  AT_ONCE_EVERY_MS,
  deliverDue,
  deliverOwedInvitations,
  startMailWorker,
  type DeliveryPass,
  type MailCadence,
  type MailTarget,
  type PassTiming,
} from './email-worker.ts';
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
  type Carrier,
  type ClaimedField,
  type ModelCaller,
  type ModelCallField,
  type ModelCallRequest,
  type ModelCallResult,
  type CallFault,
  type DropCause as CallDropCause,
  type ProviderAdapter,
  type Reservation,
  type ResolvedField,
  type ReservedCall,
  type ReserveRefusal,
} from './broker.ts';
export { reconcileProviderCalls, type ProviderProof } from './broker-reconcile.ts';
export {
  judgeCarriedTask,
  lockCarriedTask,
  type CarriedTask,
  type HeldTask,
} from './broker-carried-task.ts';
export { COUNTED_CAUSES, countedHold } from './broker-give-back.ts';
export {
  ACCEPT_WINDOW_MS,
  AGENT_EVENTS,
  ANSWER_RESEND_MS,
  ANSWER_RESENDS,
  BROKER_EVENTS,
  CALL_KEPT_MS,
  PIECE_EVERY_MS,
  SEAL_LIFE_MS,
  SEND_WINDOW_MS,
  SILENCE_MS,
  STARTED_GRACE_MS,
  WORKING_EVERY_MS,
  agentTopic,
  callTopic,
  deadlineOf,
  sendable,
  topicOf,
  type AgentEvent,
  type BrokerEvent,
  type CarriedOutcome,
  type Carriage,
  type CarryBodies,
  type CarryEvent,
  type Handoff,
  type Judged,
  type Line,
  type OfferBody,
  type Topic,
} from './carriage.ts';
export {
  opened,
  parseCarryKeys,
  sealed,
  type CarryKeys,
  type Direction,
  type SealRefusal,
  type Sealed,
} from './carry-seal.ts';
export { carriedCustody, type CarriedCustodyOptions } from './carried-custody.ts';
export { realtimeCarriage, type RealtimeCarriageOptions } from './realtime-carriage.ts';
export { standsOutside } from './outside-carriage.ts';
