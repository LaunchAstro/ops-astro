// SPDX-License-Identifier: AGPL-3.0-only
//
// The wire contract's one way in: the command surface, every command and read
// with its path and prefix, which the API, the web and the command line all
// speak, and the read results they answer with (`views.ts`). It imports
// records for types only and nothing else of the product, so a browser bundle
// can load it without the database.

export {
  COMMAND_SURFACE,
  declarationOf,
  DELEGATION_HEADER,
  pathOf,
  PREFIX,
  READS,
  type CommandDeclaration,
  type CommandName,
  type Operand,
  type OperandKind,
  type OperandSpec,
} from './surface.ts';
// The one refusal shape, for the clients that parse it off the wire. Type-only,
// so no records code reaches a bundle.
export type { CommandRefusal } from '../../core-records/src/index.ts';
// What the reads answer, declared once for the server and every client.
export type {
  AttemptView,
  AwaitingReviewResult,
  ConversationMessageView,
  ConversationPointerView,
  ConversationReadResult,
  WrapUpItemView,
  WrapUpView,
  AwaitingReviewView,
  CheckView,
  Capability,
  CapabilitiesResult,
  CommentView,
  DecisionLink,
  EvidenceView,
  GateView,
  HistoryEntry,
  InternalCommentView,
  InternalTaskDetail,
  InternalTaskRead,
  LeaseView,
  PersonListResult,
  PersonView,
  PresetPlanResult,
  ProposalVersionView,
  ProposalView,
  RunScopeView,
  CoveringGrantView,
  QueuedWork,
  QueueResult,
  ReservationView,
  SettingsReadResult,
  SessionCapabilities,
  SettingView,
  SharedTaskRead,
  SharedTaskView,
  TaskBoardResult,
  TaskDetail,
  TaskReadResult,
  TaskStateView,
  TaskSummary,
} from './views.ts';
