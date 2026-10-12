// SPDX-License-Identifier: AGPL-3.0-only
//
// The order of one person's preference saves (MP-2-11's one store). Each save
// leaves only once the client's last one has answered, so the server stores
// one client's saves in the order the person made them and the last choice is
// the one kept. A save is tagged (`data/owned.ts`), and a read's answer asks
// `savedSince` which keys a save touched while the read could not see it (sent
// after the read left, or still unanswered when it left), so its older answer
// does not undo them. The same value saved again after an answer that never
// arrived carries the same operation id (`Intents`).
//
// The ledger of what was saved is the owner's, not the client's: a step-up
// gives the same person a new client, and a save still unanswered through the
// old one is still theirs. A sign-out or a switch of the tab's owner drops
// every ledger. Only the order is the client's, so a save that never answers
// holds back that client's later saves, never a new sign-in's. An old client's
// save can then be stored after a newer one, so when an older save answers
// while a newer one is out, the newest value of that key is sent again through
// the newest client once both have answered (an answer lost on the way counts:
// the save may be stored). It goes as a new intent with its own operation id,
// since the old id would only replay its stored outcome. A save waiting in a
// client's queue when the tab's owner changes is never sent.

import {
  isRefusal,
  isUnavailable,
  type CallResult,
  type CommandOutcome,
  type OperationsClient,
} from '../operations/client.ts';
import { tabOwnerGeneration } from '../session/token.ts';
import { Intents } from './intents.ts';
import { LEFT_BEHIND, nextRequest, type Owner, type Tag } from './owned.ts';

interface Ledger {
  /** The last save of each key. */
  readonly last: Map<string, Newest>;
  /**
   * Per key, from when no read can be trusted to have seen its last save: the
   * request number its answer arrived at, or Infinity while it is unanswered.
   */
  readonly unsettledUntil: Map<string, number>;
  readonly intents: Intents;
}

/** The last save of a key, sent again over an older save that may be stored after it. */
interface Newest {
  readonly client: OperationsClient;
  readonly value: unknown;
  readonly tag: Tag;
  /** An answer came that does not rule out its being stored. */
  answered: boolean;
  /** An older save answered before it did, so it may have been stored after it. */
  overtaken: boolean;
}

let ledgers = { tab: tabOwnerGeneration(), byOwner: new Map<string, Ledger>() };
const tails = new WeakMap<OperationsClient, Promise<unknown>>();

function ledgerOf(owner: Owner): Ledger {
  const tab = tabOwnerGeneration();
  if (ledgers.tab !== tab) ledgers = { tab, byOwner: new Map() };
  const key = JSON.stringify([owner.business, owner.person]);
  let ledger = ledgers.byOwner.get(key);
  if (ledger === undefined) {
    ledger = {
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

/** Save one preference through `client`, tagged `tag`, once the client's earlier saves have answered. */
export function savePreference(
  client: OperationsClient,
  preference: string,
  value: unknown,
  tag: Tag,
  operationId?: string,
): Promise<CallResult<CommandOutcome>> {
  const ledger = ledgerOf(tag);
  const mine: Newest = { client, value, tag, answered: false, overtaken: false };
  ledger.last.set(preference, mine);
  ledger.unsettledUntil.set(preference, Number.POSITIVE_INFINITY);
  const sent = (tails.get(client) ?? Promise.resolve()).then(async () => {
    if (tag.tab !== tabOwnerGeneration()) return LEFT_BEHIND;
    const id = operationId ?? ledger.intents.idFor(preference, value);
    const result = await client.mutate(
      'preference.save',
      { preference, value },
      { operationId: id },
    );
    // No answer arrived: the save may have been stored, and the same choice again replays it.
    if (!isUnavailable(result)) ledger.intents.answered(preference, id);
    const last = ledger.last.get(preference);
    if (last === mine) ledger.unsettledUntil.set(preference, nextRequest());
    if (isRefusal(result) || last === undefined) return result;
    if (last === mine) mine.answered = true;
    else last.overtaken = true;
    if (last.answered && last.overtaken) repair(last, preference);
    return result;
  });
  tails.set(
    client,
    sent.catch(() => null),
  );
  return sent;
}

/**
 * An older save of `preference` answered while `last` was out: it may have
 * been stored after it, so send `last`'s value again through its client, as a
 * new intent.
 */
function repair(last: Newest, preference: string): void {
  last.overtaken = false;
  const tag = { ...last.tag, request: nextRequest() };
  void savePreference(last.client, preference, last.value, tag, crypto.randomUUID());
}
