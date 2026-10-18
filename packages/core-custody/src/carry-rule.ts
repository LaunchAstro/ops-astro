// SPDX-License-Identifier: AGPL-3.0-only
//
// Which calls a subscription may carry (AW-01, LF-5, C60 lines 51 and 52). A
// subscription is usable only in a person's own session for that person's own
// work, so an unattended run, a run for someone else, or a call for another
// installation's tenant is refused by name.
//
// LA-1's carve-out (#859, owner 1 October 2026; GPT in Claude's place, owner
// 7 October): on the owner's laptop, with the `local-gpt` provider, a
// subscription may carry unattended work (a scheduled job, a task's agent run)
// for the owner's own testing on made-up data. The broker sets
// `localOwnerTesting` only when the API's composition root accepted
// `OPS_AGENT_PROVIDER=local-gpt`, which it does only under
// `OPS_ENVIRONMENT=local`, and only for a route whose provider is
// `local_gpt`. Another installation's tenant stays refused under it, and so
// does an attended call for someone else's work. Everywhere else, unchanged.
//
// Owner line 72 (ops-astro-roadmap `docs/decisions/execution.md`, 28 September
// and 13 October 2026): work on a task with a client never reaches a
// subscription, in its own person's session or under the carve-out.
//
// The owner's ChatGPT plan's route (#1620 P4), answered from the M5, carries
// a run nobody attends, but only one on a task the owner created; any other
// is refused `SUBSCRIPTION_NOT_OWNER_STARTED`. Like `credentials.ts`, this file
// imports no connector code.

import type { CredentialKind } from './credentials.ts';

export interface CarryContext {
  /** No person is present in their own session for this call. */
  readonly unattended: boolean;
  /** The person whose session presents the credential, if any. */
  readonly sessionPersonId: string | null;
  /** The person the run works for. */
  readonly workForPersonId: string | null;
  /** The installation the call's tenant belongs to, and the credential's own. */
  readonly tenantInstallation: string;
  readonly credentialInstallation: string;
  /** LA-1's local carve-out: true only on the laptop, on a `local_gpt` route. */
  readonly localOwnerTesting?: boolean;
  /**
   * The work is a client's: its task has a client key. The task path always says;
   * the conversation seam does not, and its client refusal stays the command layer's (C60).
   */
  readonly clientWork?: boolean;
  /** The route is the owner's ChatGPT plan's (`carriesOnPlan`), which carries owner-started runs only. */
  readonly planRoute?: boolean;
  /** The run's task was created by a person then holding the owner role (owner line 72's provenance). */
  readonly ownerStarted?: boolean;
}

export type CarryRefusal =
  | 'SUBSCRIPTION_UNATTENDED'
  | 'SUBSCRIPTION_OTHER_TENANT'
  | 'SUBSCRIPTION_NOT_OWN_WORK'
  | 'SUBSCRIPTION_NOT_FOR_CLIENT_WORK'
  | 'SUBSCRIPTION_NOT_OWNER_STARTED';

/**
 * The local session's provider key (`LOCAL_GPT_PROVIDER` in core-connectors).
 * Written out here so this file imports no connector code; a test holds the
 * two equal.
 */
export const LOCAL_SESSION_PROVIDER = 'local_gpt';

/** LA-1's carve-out applies: the broker carries it, and the route is the local session's. */
export function carriesLocally(
  broker: { readonly localOwnerTesting?: boolean },
  route: { readonly provider: string },
): boolean {
  return broker.localOwnerTesting === true && route.provider === LOCAL_SESSION_PROVIDER;
}

/**
 * The owner's ChatGPT plan's provider key (`CHATGPT_PLAN_PROVIDER` in
 * core-connectors), written out for the same reason; a test holds the two equal.
 */
export const PLAN_PROVIDER = 'chatgpt_plan';

/** The route is the owner's ChatGPT plan, answered from the M5 (#1620 P4). */
export const carriesOnPlan = (route: { readonly provider: string }): boolean =>
  route.provider === PLAN_PROVIDER;

/**
 * A subscription carries only a person's own attended work, with no client, in
 * their own installation. The plan's route carries a run nobody attends, but
 * only one the owner started; one the owner did not start is refused by name.
 */
export function mayCarry(
  kind: CredentialKind,
  context: CarryContext,
): { readonly ok: true } | { readonly ok: false; readonly code: CarryRefusal } {
  if (kind !== 'subscription') return { ok: true };
  if (context.clientWork === true) return { ok: false, code: 'SUBSCRIPTION_NOT_FOR_CLIENT_WORK' };
  if (context.tenantInstallation !== context.credentialInstallation) {
    return { ok: false, code: 'SUBSCRIPTION_OTHER_TENANT' };
  }
  if (context.planRoute === true && context.ownerStarted !== true) {
    return { ok: false, code: 'SUBSCRIPTION_NOT_OWNER_STARTED' };
  }
  const unattended = context.unattended || context.sessionPersonId === null;
  if (unattended && context.planRoute === true) return { ok: true };
  // Under the carve-out an unattended call has no session to compare its work with.
  if (unattended) {
    return context.localOwnerTesting === true
      ? { ok: true }
      : { ok: false, code: 'SUBSCRIPTION_UNATTENDED' };
  }
  if (context.workForPersonId !== context.sessionPersonId) {
    return { ok: false, code: 'SUBSCRIPTION_NOT_OWN_WORK' };
  }
  return { ok: true };
}
