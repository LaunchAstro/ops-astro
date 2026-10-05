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
  EXTERNAL_WRITES,
  admitsSelfWrite,
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
// A currency's minor digits, the ISO 4217 table the server and the browser share.
export { minorDigits } from './currency.ts';
// What a task's page link may hold, for the server's check and the web's door.
export { PAGE_LINK_LIMIT, isInProductLink } from './page-link.ts';
export { TASK_STAGES, type TaskStage } from './task-stages.ts';
export { TASK_CATEGORIES, type TaskCategory } from './task-categories.ts';
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
  AccessPreview,
  AccessReadResult,
  AttemptView,
  AwaitingReviewResult,
  ConversationMessageView,
  ConversationPointerView,
  ConversationListResult,
  ConversationReadResult,
  ConversationTabView,
  WrapUpItemView,
  WrapUpView,
  AwaitingReviewView,
  CheckView,
  RunPinView,
  RunReadView,
  BoardCrumb,
  BreachNoticeDraft,
  BreachNoticesResult,
  BreachRunbookLink,
  HealthFault,
  HealthSourceName,
  HealthSourceState,
  HealthSourceView,
  LastTestedRestoreView,
  OperationsReadResult,
  PrivacyIncidentView,
  SecurityAlertView,
  ServiceHealthSection,
  ServiceHealthState,
  ServiceHealthView,
  Capability,
  CapabilitiesResult,
  SessionPersonResult,
  ClientListResult,
  ClientPrivacyView,
  ClientView,
  CommentView,
  DecisionLink,
  EvidenceView,
  ExecutionEvent,
  ExecutionGraph,
  ExecutionNode,
  ExecutionRun,
  GateView,
  HistoryEntry,
  InboxCountResult,
  InboxEntry,
  InboxReadResult,
  UnattendedView,
  InternalCommentView,
  InternalTaskDetail,
  InternalTaskRead,
  LeaseView,
  LedgerDayView,
  LedgerEventView,
  PersonListResult,
  TagListResult,
  TagView,
  AgentAssigneeView,
  AgentOfferView,
  BoardComments,
  TeamListResult,
  TeamMemberView,
  PersonView,
  PresetPlanResult,
  ProposalVersionView,
  ProposalView,
  RunScopeView,
  CoveringGrantView,
  QueuedWork,
  QueueResult,
  RankView,
  ReceiptResult,
  ReservationView,
  EnvelopeView,
  BudgetStopView,
  RunStateView,
  TaskLedgerView,
  SearchHit,
  SettingsReadResult,
  SessionCapabilities,
  SettingView,
  SharedTaskRead,
  SharedTaskView,
  TaskAlert,
  OutageView,
  BoardTask,
  StepView,
  TaskBoardResult,
  TaskTodosResult,
  TodoView,
  TaskDetail,
  TaskEnvelope,
  TaskExecution,
  TaskExecutionResult,
  TaskLedgerResult,
  TaskReadResult,
  TaskSearchResult,
  TaskStateView,
  TaskSummary,
  TaskTimeView,
  TimeEntryView,
} from './views.ts';
export type { MapComponentView, MapView, MapViewResult, MapFrontierResult } from './views-map.ts';
// AW-04's attribution and allowance answers, beside the other agent views.
export type {
  AllowanceResult,
  AttributionResult,
  PlanningAllowanceView,
  PreReviewAttribution,
  PreReviewRun,
} from './views-agent.ts';
// Custody's secrets as Settings ▸ Keys reads them (C31).
export type { SecretListResult, SecretView } from './connection-views.ts';
// AW-04: a plan version as a planning reply offers it in the chat
export type { PlanOffer, PlanOfferStep } from './plan-offer.ts';
// the command catalogue and its parity check (API-1)
export * from './catalogue.ts';
// each command's data effects and its class, read by the first-client gate (S0-5)
export * from './data-effects.ts';
// the operations whose value is visual, and the command line's hand-off to them (AW-09)
export { handoffAddress, handoffOf, VISUAL_HANDOFFS, type VisualHandoff } from './handoff.ts';
