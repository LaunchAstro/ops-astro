// SPDX-License-Identifier: AGPL-3.0-only
//
// Who takes, renews or hands back a lease: one model of the caller for pickup,
// renewal and handback (thermo review b483399, M6). Each operation builds the
// runtime's own input from it, so what reaches `core-runtime` is unchanged.

import { subjectsOf, type Subject } from '../authority/grants.ts';
import type { CommandContext } from './context.ts';

export interface AgentClaimant {
  readonly claimant: 'agent';
  /** The agent's own actor: the lease holder, and a successor's proposer. */
  readonly actorId: string;
}

export interface PersonClaimant {
  readonly claimant: 'person';
  readonly personId: string;
  /** The person's own actor: the lease holder, and a successor's proposer. */
  readonly actorId: string;
  /** The session's subjects, whose live grants the runtime re-reads under its locks. */
  readonly subjects: readonly Subject[];
  readonly collection: string;
}

export type Claimant = AgentClaimant | PersonClaimant;

export function agentClaimant(actorId: string): AgentClaimant {
  return { claimant: 'agent', actorId };
}

/** The verified person of this command, claiming under their own grants. */
export function personClaimant(context: CommandContext): PersonClaimant {
  return {
    claimant: 'person',
    personId: context.session.personId,
    actorId: context.session.actorId,
    subjects: subjectsOf(context.session),
    collection: context.declaration.collection,
  };
}
