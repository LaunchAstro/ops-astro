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
 * The carve-out's standing, apart from what is sent: only the outside paid
 * route (`openrouter`, cloud, an API key of this installation), only its one
 * conversation operation, only a person in their own undelegated session, and
 * only a person listed for this business. A carried call's judgements ask it
 * again at their locked instant (`carriage-origin.ts`).
 */
export function outsideStanding(
  broker: { readonly installation: string; readonly outsidePeople?: readonly string[] },
  route: {
    readonly provider: string;
    readonly reach: string;
    readonly credentialKind: CredentialKind;
    readonly installation: string;
  },
  party: Omit<OutsideCall, 'fieldNames' | 'authors'>,
): boolean {
  const person = party.caller.attendedByPersonId;
  const listed = (pair: string): boolean =>
    person !== null && sameId(pair, `${party.businessId}:${person}`);
  return (
    route.provider === OUTSIDE_PROVIDER &&
    route.reach === 'cloud' &&
    route.credentialKind === 'api_key' &&
    route.installation === broker.installation &&
    party.operation.key === OUTSIDE_OPERATION &&
    party.operation.provider === OUTSIDE_PROVIDER &&
    party.caller.delegationId === null &&
    (broker.outsidePeople ?? []).some((pair) => listed(pair))
  );
}

/**
 * The paid chat's carve-out (#1508, CP-R1): a person's own typed words, and
 * their own conversation's own turns, may go to the outside paid route. Only
 * with the standing above, and only the message, page and earlier turns,
 * each person turn written by the caller. Everywhere else free text stays
 * local (`eligibleRoutes`).
 */
export function carriesOutside(
  broker: Parameters<typeof outsideStanding>[0],
  route: Parameters<typeof outsideStanding>[1],
  call: OutsideCall,
): boolean {
  const { caller, fieldNames, authors } = call;
  const names = new Set(fieldNames);
  return (
    outsideStanding(broker, route, call) &&
    names.size === fieldNames.length &&
    names.has('message') &&
    [...names].every((name) => OUTSIDE_FIELDS.has(name)) &&
    authors.length > 0 &&
    authors.every((author) => sameId(author, caller.actorId))
  );
}

/**
 * A carried paid call's standing again, at its judgement's locked instant
 * (`carriage-origin.ts`): its route still the outside paid route, the person
 * still listed as the broker's settings hold them now, and the conversation
 * still on the model it was asked on, for the person's own undelegated
 * session. An unpaid call has none to judge.
 */
export function standsOutside(
  broker: Parameters<typeof outsideStanding>[0] & {
    readonly routes: readonly (Parameters<typeof outsideStanding>[1] & { readonly key: string })[];
  },
  held: {
    readonly operation: string;
    readonly provider: string;
    readonly route: string;
    readonly model: string | null;
  },
  asked: {
    readonly businessId: string;
    readonly actorId: string;
    readonly personId: string;
    readonly model: string | null | undefined;
  },
): boolean {
  if (held.operation !== OUTSIDE_OPERATION) return true;
  const route = broker.routes.find((one) => one.key === held.route);
  const party = {
    businessId: asked.businessId,
    operation: { key: held.operation, provider: held.provider },
    caller: { actorId: asked.actorId, delegationId: null, attendedByPersonId: asked.personId },
  };
  return route !== undefined && held.model === asked.model && outsideStanding(broker, route, party);
}
