// SPDX-License-Identifier: AGPL-3.0-only
//
// The authority surface L3 wires into the command registry.
//
// This file exists to be a contract rather than a convenience. L3 builds the
// handlers for `task.comment`, `task.pickup`, `task.handback` and the gate
// against the names below; pinning them in one place means the consumer reads
// an interface instead of a module layout, and a later rearrangement of
// `delegations.ts` is not a change to what L3 imports.
//
// Two things are deliberately not here. There is no "current permissions"
// object, because a permission held across a call is the thing purpose
// delegation exists to avoid. And there is no decide path: no export below
// can produce one for a delegated agent, which is I07 held by what the module
// does not offer rather than by a check somebody remembers to write.

export {
  checkAuthority,
  effectiveGrants,
  issueGrant,
  revokeGrant,
  subjectsOf,
  type Action,
  type Decision,
  type EffectiveGrant,
  type ProposedGrant,
  type Refusal as AuthorityRefusal,
  type Scope,
  type ScopeKind,
  type ScopeRequest,
  type Subject,
  type SubjectKind,
} from './grants.ts';

export {
  checkDelegatedAuthority,
  digestOf,
  mintDelegation,
  resolveDelegation,
  revokeDelegation,
  settleDelegation,
  type DelegableAction,
  type Delegation,
  type DelegationDecision,
  type DelegationRefusal,
  type DelegationRefusalCode,
  type MintedDelegation,
  type MintRequest,
} from './delegations.ts';
