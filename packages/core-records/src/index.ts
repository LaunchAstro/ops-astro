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
  type DelegationCredentialKeys,
} from './authority/credential-keys.ts';
export {
  CREDENTIAL_EXCLUDED_ACTIONS,
  CREDENTIAL_MAX_DAYS,
  deriveAgentCredential,
  issueAgentCredential,
  lockAgentCredential,
  revokeAgentCredential,
  type AgentCredential,
  type CredentialKey,
} from './authority/agent-credentials.ts';
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
  grantFingerprint,
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
export { heldScopes } from './authority/held-scopes.ts';
export { heldPermissions, type HeldPermission } from './authority/held-permissions.ts';
export {
  grantAccess,
  lastManager,
  lockAccess,
  otherManagers,
  type AccessGrant,
} from './authority/access.ts';
export {
  clientsReached,
  CLIENT_NAME_MOST,
  createClient,
  isClientHere,
  listAllClients,
  type AccessDecision,
  type ClientRow,
} from './clients/clients.ts';
export {
  readableRecordIds,
  readableScope,
  type ReadableScope,
} from './authority/readable-scope.ts';
export { issueShare, withdrawShares } from './authority/shares.ts';
export {
  EXPIRED_FIXES,
  NO_AGENT_FIXES,
  resolveAgentLogin,
  type AgentSession,
} from './identity/agent-login.ts';
export { recordBodyRefusal } from './identity/authentication-attempts.ts';
export {
  NO_MEMBERSHIP_FIXES,
  standsOnShares,
  resolveLogin,
  withSession,
  type SecondFactorRule,
  type Session,
  type VerifiedSubject,
} from './identity/login-resolution.ts';
export { withStanding } from './identity/standing.ts';
export {
  NO_ASSURANCE,
  SESSION_ABSOLUTE_SECONDS,
  type Assurance,
  type AssuranceLevel,
} from './identity/verified-subject.ts';
export {
  liveFactor,
  recordFactorEnrolled,
  recordFactorRemoved,
  recordFactorVerified,
  type FactorStatus,
  type SecondFactor,
} from './identity/second-factor.ts';
export {
  endOtherSeenSessions,
  endOwnSession,
  listSeenSessions,
  type SeenSession,
  type SessionEndReason,
} from './identity/sessions.ts';
export {
  isMoneyKey,
  judgeStepUp,
  MONEY_STEP_UP_SETTING,
  refuseStaleMoneyStep,
  STEP_UP_WINDOW_SECONDS,
} from './authority/step-up.ts';
export {
  INFORMATION_KINDS,
  readPrivacyIncident,
  readPrivacyIncidents,
  recordPrivacyIncident,
  type InformationKind,
  type PrivacyIncident,
  type PrivacyIncidentFacts,
} from './operations/privacy-incidents.ts';
export {
  draftBreachNotices,
  type BreachNotice,
  type BreachNoticeInput,
  type NoticeRecipient,
} from './operations/breach-notices.ts';
export {
  LEGAL_DOCUMENTS,
  PUBLIC_LEGAL_DOCUMENTS,
  approveLegalVersion,
  draftLegalVersion,
  publishLegalVersion,
  readPublishedLegal,
  type DraftedVersion,
  type LegalDocument,
  type PublishedVersion,
  type VersionRefusal,
} from './operations/legal-documents.ts';
export {
  readDataClasses,
  setDataClass,
  type DataClass,
  type DataClassesState,
  type ListedDataClass,
} from './operations/data-classes.ts';
export {
  readRegister,
  setOverseasService,
  type ListedService,
  type OverseasService,
  type RegisterState,
} from './operations/overseas-services.ts';
export {
  admitsPreference,
  dismissTip,
  isPreferenceKey,
  PREFERENCE_KEYS,
  readPreferences,
  savePreference,
  type PreferenceKey,
} from './preferences/store.ts';
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
export { readScopes, taskAccess } from './inbox/access.ts';
export {
  raiseAssignment,
  raiseDecision,
  raiseEscalation,
  raiseIncident,
  raiseRunSettled,
} from './inbox/raise.ts';
export { raiseMentions, readMentions, seenBy, type Mentioned } from './inbox/mentions.ts';
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
export { UNPRODUCED_CODES } from './register-unproduced.ts';
export * from './tasks/content.ts';
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
export { readTaskFamily, type FamilyRow, type TaskFamily } from './tasks/family.ts';
export { changesSince, type ChangesSince, type TaskChange } from './tasks/changes.ts';
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
export { connectOutbox, type ApiEvent, type Outbox } from './tenancy/outbox.ts';
