// SPDX-License-Identifier: AGPL-3.0-only
//
// The paid chat's carve-out (#1508, CP-R1): the one door by which free text
// may reach an outside model. It imports no connector code, as
// `credentials.ts` imports none.

import type { CredentialKind } from './credentials.ts';

/**
 * The outside paid provider and its one operation (#1508), written out as
 * `LOCAL_SESSION_PROVIDER` is; a test holds them equal to core-connectors'.
 */
export const OUTSIDE_PROVIDER = 'openrouter';
export const OUTSIDE_OPERATION = 'model.conversation_answer_openrouter';

/** The fields a paid conversation call may carry; `message` always among them. */
const OUTSIDE_FIELDS: ReadonlySet<string> = new Set(['page', 'earlier', 'message']);

/** One spelling of an id: the store compares UUIDs whatever their case. */
const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** What the carve-out judges of one conversation call. */
export interface OutsideCall {
  readonly businessId: string;
  readonly operation: { readonly key: string; readonly provider: string };
  readonly caller: {
    readonly actorId: string;
    readonly delegationId: string | null;
    readonly attendedByPersonId: string | null;
  };
  readonly fieldNames: readonly string[];
  /** Who wrote each person turn sent: the asked message and the earlier ones. */
  readonly authors: readonly string[];
}

/**
 * The paid chat's carve-out (#1508, CP-R1): a person's own typed words, and
 * their own conversation's own turns, may go to the outside paid route. Only
 * that route (`openrouter`, cloud, an API key of this installation), only its
 * one conversation operation, only the person in their own undelegated
 * session, only a person listed for this business, and only the message, page
 * and earlier turns, each person turn written by the caller. Everywhere else
 * free text stays local (`eligibleRoutes`).
 */
export function carriesOutside(
  broker: { readonly installation: string; readonly outsidePeople?: readonly string[] },
  route: {
    readonly provider: string;
    readonly reach: string;
    readonly credentialKind: CredentialKind;
    readonly installation: string;
  },
  call: OutsideCall,
): boolean {
  const { caller, fieldNames, authors } = call;
  const person = caller.attendedByPersonId;
  const names = new Set(fieldNames);
  const listed = (pair: string): boolean =>
    person !== null && sameId(pair, `${call.businessId}:${person}`);
  return (
    route.provider === OUTSIDE_PROVIDER &&
    route.reach === 'cloud' &&
    route.credentialKind === 'api_key' &&
    route.installation === broker.installation &&
    call.operation.key === OUTSIDE_OPERATION &&
    call.operation.provider === OUTSIDE_PROVIDER &&
    caller.delegationId === null &&
    (broker.outsidePeople ?? []).some((pair) => listed(pair)) &&
    names.size === fieldNames.length &&
    names.has('message') &&
    [...names].every((name) => OUTSIDE_FIELDS.has(name)) &&
    authors.length > 0 &&
    authors.every((author) => sameId(author, caller.actorId))
  );
}
