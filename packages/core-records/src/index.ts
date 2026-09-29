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
  effectiveGrants,
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
export {
  EXPIRED_FIXES,
  NO_AGENT_FIXES,
  resolveAgentLogin,
  type AgentSession,
} from './identity/agent-login.ts';
export { recordBodyRefusal } from './identity/authentication-attempts.ts';
export {
  NO_MEMBERSHIP_FIXES,
  withSession,
  type Session,
  type VerifiedSubject,
} from './identity/login-resolution.ts';
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
  CALLER_VISIBLE,
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
