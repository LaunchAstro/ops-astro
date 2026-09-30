// SPDX-License-Identifier: AGPL-3.0-only
//
// The wire contract's one way in: the command surface, every command and read
// with its path and prefix, which the API, the web and the command line all
// speak, and the read results they answer with (`views.ts`). It imports
// records for types only and nothing else of the product, so a browser bundle
// can load it without the database.

export {
  COMMAND_SURFACE,
  CSRF_HEADER,
  declarationOf,
  effectAttemptOf,
  effectOperationId,
  DELEGATION_HEADER,
  pathOf,
  ACCOUNT_AVAILABILITY_PATH,
  PREFIX,
  PUBLIC_PREFIX,
  READS,
  SESSION_COOKIE,
  SESSION_PATH,
  SESSION_HEADER,
  type CommandDeclaration,
  type CommandName,
  type Operand,
  type OperandKind,
  type OperandSpec,
} from './surface.ts';
// The keys a grant may carry (C32).
export { GRANTABLE_KEYS, isGrantableKey, SELF_SCOPED_COLLECTIONS } from './permission-keys.ts';
export {
  dismissedTipCount,
  isTipRef,
  tipKey,
  tipShown,
  TIPS_HELD_MAX,
  type TipRef,
} from './tips.ts';
// The one refusal shape, for the clients that parse it off the wire. Type-only,
// so no records code reaches a bundle.
export type { CommandRefusal } from '../../core-records/src/index.ts';
// What the reads answer, declared once for the server and every client.
export type {
  AccessAgent,
  AccessGrant,
  AccessPermission,
  AccessPerson,
  AccessReadResult,
  AttemptView,
  BreachNoticeDraft,
  BreachNoticesResult,
  BreachRunbookLink,
  HealthFault,
  HealthSourceName,
  HealthSourceState,
  HealthSourceView,
  OperationsReadResult,
  PrivacyIncidentView,
  ServiceHealthSection,
  ServiceHealthState,
  ServiceHealthView,
  Capability,
  CapabilitiesResult,
  SessionPersonResult,
  ClientListResult,
  ClientView,
  CommentView,
  DecisionLink,
  EvidenceView,
  ExecutionEvent,
  ExecutionRun,
  GateView,
  HistoryEntry,
  InboxCountResult,
  InboxEntry,
  InboxReadResult,
  InternalCommentView,
  InternalTaskDetail,
  InternalTaskRead,
  LeaseView,
  LedgerDayView,
  LedgerEventView,
  PersonListResult,
  TeamListResult,
  TeamMemberView,
  PersonView,
  PresetPlanResult,
  ProposalVersionView,
  ProposalView,
  QueuedWork,
  QueueResult,
  ReceiptResult,
  ReservationView,
  SearchHit,
  SettingsReadResult,
  SessionCapabilities,
  SettingView,
  SharedTaskRead,
  SharedTaskView,
  TaskAlert,
  OutageView,
  TaskBoardResult,
  TaskDetail,
  TaskEnvelope,
  TaskExecution,
  TaskExecutionResult,
  TaskLedgerResult,
  TaskReadResult,
  TaskSearchResult,
  TaskStateView,
  TaskSummary,
} from './views.ts';
// the command catalogue and its parity check (API-1)
export * from './catalogue.ts';
// each command's data effects and its class, read by the first-client gate (S0-5)
export * from './data-effects.ts';
