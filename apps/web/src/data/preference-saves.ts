// SPDX-License-Identifier: AGPL-3.0-only
//
// The order of one person's preference saves (MP-2-11's one store). Each save
// leaves only once that person's last one in this business has answered, so
// the server stores them in the order the person made them and the last
// choice is the one kept. A save is tagged (`data/owned.ts`), and a read's
// answer asks `savedSince` which keys a save touched while the read could not
// see it (sent after the read left, or still unanswered when it left), so its
// older answer does not undo them. The same value saved again after an answer
// that never arrived carries the same operation id (`Intents`).
//
// The ledger is the owner's, not the client's: a step-up gives the same person
// a new client, and a save still unanswered through the old one is still theirs.
// A sign-out or a switch of the tab's owner drops every ledger.

import {
  isUnavailable,
  type CallResult,
  type CommandOutcome,
  type OperationsClient,
} from '../operations/client.ts';
import { tabOwnerGeneration } from '../session/token.ts';
import { Intents } from './intents.ts';
import { nextRequest, type Owner, type Tag } from './owned.ts';

interface Ledger {
  tail: Promise<unknown>;
  /** The request number of the last save of each key. */
  readonly last: Map<string, number>;
  /**
   * Per key, from when no read can be trusted to have seen its last save: the
   * request number its answer arrived at, or Infinity while it is unanswered.
   */
  readonly unsettledUntil: Map<string, number>;
  readonly intents: Intents;
}

let ledgers = { tab: tabOwnerGeneration(), byOwner: new Map<string, Ledger>() };

function ledgerOf(owner: Owner): Ledger {
  const tab = tabOwnerGeneration();
  if (ledgers.tab !== tab) ledgers = { tab, byOwner: new Map() };
  const key = JSON.stringify([owner.business, owner.person]);
  let ledger = ledgers.byOwner.get(key);
  if (ledger === undefined) {
    ledger = {
      tail: Promise.resolve(),
      last: new Map(),
      unsettledUntil: new Map(),
      intents: new Intents(),
    };
    ledgers.byOwner.set(key, ledger);
  }
  return ledger;
}

/** Whether a save of `preference` may be missing from a read tagged `since`: its answer is older. */
export function savedSince(preference: string, since: Tag): boolean {
  return (ledgerOf(since).unsettledUntil.get(preference) ?? 0) > since.request;
}

/** Save one preference through `client`, tagged `tag`, once its owner's earlier saves have answered. */
export function savePreference(
  client: OperationsClient,
  preference: string,
  value: unknown,
  tag: Tag,
): Promise<CallResult<CommandOutcome>> {
  const ledger = ledgerOf(tag);
  ledger.last.set(preference, tag.request);
  ledger.unsettledUntil.set(preference, Number.POSITIVE_INFINITY);
  const sent = ledger.tail.then(async () => {
    const operationId = ledger.intents.idFor(preference, value);
    const result = await client.mutate('preference.save', { preference, value }, { operationId });
    // No answer arrived: the save may have been stored, and the same choice again replays it.
    if (!isUnavailable(result)) ledger.intents.answered(preference, operationId);
    if (ledger.last.get(preference) === tag.request) {
      ledger.unsettledUntil.set(preference, nextRequest());
    }
    return result;
  });
  ledger.tail = sent.catch(() => null);
  return sent;
}
