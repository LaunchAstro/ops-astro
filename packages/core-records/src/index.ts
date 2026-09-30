// SPDX-License-Identifier: AGPL-3.0-only
//
// The records package's one way in: tenancy, identity, authority, the records
// engine, the task type and the refusal register. It is the bottom layer. It
// imports neither the runtime nor the command package, and every other package
// reaches it through this file (`.dependency-cruiser.cjs`).
//
// Two names are renamed here because two modules use them for different
// things: `Refusal` is the authority check's, and the identity layer's is
// `IdentityRefusal`.

export {
  configuredCredentialKeys,
  DERIVED_SCHEME,
  KEY_FILE_VARIABLE,
  LEGACY_SCHEME,
  withCredentialKeys,
  type CredentialKeysDecision,
} from './authority/credential-keys.ts';
export { readEnvFile } from './env-file.ts';
export {
  checkDelegatedAuthority,
  digestOf,
  mintDelegation,
  resolveDelegation,
  resolveHistoricalDelegation,
  resolveLiveById,
  resolveNarrowedDelegation,
  resolveSettledByLease,
  revokeDelegation,
  settleDelegation,
  type Delegation,
  type DelegationRefusalCode,
  type MintedDelegation,
} from './authority/delegations.ts';
export {
  checkAuthority,
  EFFECTIVE as EFFECTIVE_GRANTS,
  effectiveGrants,
  OPERATIONS_MANAGE,
  revokeGrant,
  subjectsOf,
  type Action,
  type Decision,
  type EffectiveGrant,
  type Scope,
  type ScopeKind,
  type ScopeRequest,
  type Subject,
} from './authority/grants.ts';
export { grantedScopes } from './authority/scopes.ts';
export { coveredScopes } from './authority/covered-scopes.ts';
export {
  EXPIRED_FIXES,
  NO_AGENT_FIXES,
  resolveAgentLogin,
  type AgentSession,
} from './identity/agent-login.ts';
export { recordBodyRefusal } from './identity/authentication-attempts.ts';
export {
  NO_MEMBERSHIP_FIXES,
  resolveLogin,
  withSession,
  type Session,
  type VerifiedSubject,
} from './identity/login-resolution.ts';
export {
  readInboxItems,
  countOwedItems,
  INBOX_HISTORY_PAGE,
  INBOX_HISTORY_SCAN,
} from './inbox/read.ts';
export {
  owes,
  raiseInboxItem,
  stampSeen,
  recordDeliveryAttempt,
  type DeliveryChannel,
  type DeliveryState,
  type InboxAccess,
  type InboxFactKind,
  type InboxItem,
  type InboxAlert,
  type InboxReason,
  type InboxWorkState,
  type RaiseInboxItem,
} from './inbox/items.ts';
export { taskAccess } from './inbox/access.ts';
export {
  raiseAssignment,
  raiseDecision,
  raiseEscalation,
  raiseIncident,
  raiseRunSettled,
} from './inbox/raise.ts';
export { raiseMentions, readMentions, type Mentioned } from './inbox/mentions.ts';
export { clearDecision, withdrawEndedGates } from './inbox/clear.ts';
export { readUnattended, type UnattendedItem } from './inbox/unattended.ts';
export {
  isSettingRevisionStale,
  readBusinessSetting,
  readBusinessSettings,
  writeBusinessSetting,
  type SettingValueType,
} from './records/business-settings.ts';
export { readFieldDefinitions } from './records/field-store.ts';
export { isLive, refuseGenericWrite, type FieldDefinition } from './records/fields.ts';
export { planPresetSync, type PresetField, type PresetPlan } from './records/preset-plan.ts';
export { isRecordsRefusal, type RecordsRefusal } from './records/refusals.ts';
export {
  audienceNotPermitted,
  CALLER_VISIBLE,
  fourEyesRequired,
  gateAlreadyDecided,
  gatePending,
  isCommandRefusal,
  REFUSAL_REGISTER,
  refuseCommand,
  registeredRefusal,
  statusOf,
  type CommandRefusal,
  type RefusalCode,
  type RuntimeRefusalCode,
} from './register.ts';
export {
  COMMENT_TYPE_KEY,
  externalCommentProjection,
  readTaskComments,
  writeComment,
  type CommentAudience,
  type CommentType,
} from './tasks/comments.ts';
export {
  DERIVED_ON_CREATE,
  deriveSource,
  lockSiblings,
  mergeFieldValues,
  nextTaskKey,
  planTaskPlacement,
  RANK_GAP,
  rankAfterSiblings,
  siblingRanks,
  wouldCloseParentLoop,
  type EntryPoint,
} from './tasks/placement.ts';
export { slotOf, TASK_SPINE, TASK_TYPE_KEY } from './tasks/spine.ts';
export { readTaskStates, setTaskState, type TaskStateRow } from './tasks/state.ts';
export { TASK_STATE_TYPE_KEY, type MachineCategory } from './tasks/states.ts';
export { purgeTrashedRecords, restoreBatch, trashSubtree } from './tasks/trash.ts';
export {
  advisoryLock,
  connect,
  connectAsAdmin,
  connectListener,
  isBusinessId,
  type AdminConnection,
  type BusinessId,
  type Database,
  type Listener,
  type TenantQuery,
} from './tenancy/database.ts';
export { isUuid } from './tenancy/ids.ts';
export {
  clearSecret,
  isSecretStale,
  listSecrets,
  markSecretUsed,
  readSecret,
  setSecret,
  type SecretRow,
  type SecretScope,
  type SecretStale,
  type SecretWritten,
} from './custody/index.ts';
export {
  generateSealingPair,
  loadSealingKey,
  seal,
  type Sealed,
  type SealingKey,
} from './custody/index.ts';
export {
  isRepairRefusal,
  listConnections,
  startRepair,
  type ConnectionClient,
  type ConnectionRow,
  type ConnectionStatus,
  type RepairRefusal,
  type RepairStarted,
} from './connections/fleet.ts';
export { listRunCosts, type CostPeriod, type RunCostRow } from './costs/run-costs.ts';
export {
  listAgents,
  listGrants,
  listTripwires,
  readNightRound,
  type AgentRow,
  type GrantRow,
  type GrantState,
  type NightRound,
  type NightStepRow,
  type TripwireRow,
} from './connections/signal.ts';
export {
  ALL_CLASSES,
  classMatches,
  clientClasses,
  deriveGraduation,
  listGraduation,
  lockClientMandates,
  mandateIsLive,
  scopeChoices,
  type Derived,
  type Earned,
  type GraduationClassRow,
  type GraduationState,
  type MandateRow,
} from './mandates/mandates.ts';
export {
  bumpGraduationClass,
  insertMandate,
  lockGraduationClass,
  lockMandate,
  revokeMandate,
  type MandateFiling,
} from './mandates/writes.ts';
export {
  changeActivation,
  insertActivation,
  insertDefinition,
  readActivation,
  readVersion,
  releaseVersion,
  type ActivationMode,
  type ActivationRow,
  type ActivationSetting,
  type DefinitionKind,
  type DefinitionVersionRow,
  type VersionRelease,
} from './automations/automations.ts';
export {
  claimOccurrence,
  FIRING_LIMITS,
  type OccurrenceCause,
  type OccurrenceClaim,
  type OccurrenceOutcome,
  type OccurrenceRow,
  waitingOccurrences,
} from './automations/occurrences.ts';
export {
  adoptVersion,
  listApprovals,
  previousVersion,
  readStandingApproval,
  revokeApproval,
  turnOffActivation,
  type AdoptionAct,
  type AdoptionResult,
  type RevokeResult,
  type StandingApprovalRow,
  type TurnOffResult,
} from './automations/approvals.ts';
export {
  dispatchOccurrence,
  readOccurrenceFacts,
  type Dispatch,
  type DispatchOutcome,
  type DispatchRow,
  type OccurrenceFacts,
  type RunRefused,
  type RunRequest,
  type RunStarter,
} from './automations/dispatch.ts';
export {
  listRegistry,
  type Registry,
  type RegistryActivation,
  type RegistryDefinition,
  type RegistryVersion,
} from './automations/registry.ts';
export { CLIENT_TYPE_KEY, installClientType } from './tasks/install.ts';
export {
  ONBOARDING_TEMPLATES,
  stepTaskTitle,
  type OnboardingTemplate,
  type StepKind,
  type TemplateStep,
} from './onboarding/template.ts';
export {
  closeStep,
  failStep,
  insertOnboarding,
  insertStepTask,
  lockStepOfTask,
  onboardingOfClient,
  type OnboardingStepRow,
  type StepState,
} from './onboarding/onboardings.ts';
export { closeStepMove, raiseStepMoves } from './onboarding/moves.ts';
export { hasRoom, type DurableLimit } from './tenancy/limit.ts';
export { connectOutbox, type ApiEvent, type Outbox } from './tenancy/outbox.ts';
