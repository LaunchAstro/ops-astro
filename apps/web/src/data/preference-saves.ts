// SPDX-License-Identifier: AGPL-3.0-only
//
// The order of one person's preference saves (MP-2-11's one store). Each save
// leaves only once the client's last one has answered, so the server stores
// them in the order the person made them and the last choice is the one kept.
// A read notes `savesSoFar` before it asks; `savedSince` then tells it which
// keys a later save has already changed, so its older answer does not undo
// them.

import type { CallResult, CommandOutcome, OperationsClient } from '../operations/client.ts';

interface Ledger {
  tail: Promise<unknown>;
  made: number;
  readonly last: Map<string, number>;
}

const ledgers = new WeakMap<OperationsClient, Ledger>();

function ledgerOf(client: OperationsClient): Ledger {
  let ledger = ledgers.get(client);
  if (ledger === undefined) {
    ledger = { tail: Promise.resolve(), made: 0, last: new Map() };
    ledgers.set(client, ledger);
  }
  return ledger;
}

/** How many saves this client has started: a read notes it before it asks. */
export function savesSoFar(client: OperationsClient): number {
  return ledgerOf(client).made;
}

/** Whether `preference` was saved through this client after `mark` (`savesSoFar`). */
export function savedSince(client: OperationsClient, preference: string, mark: number): boolean {
  return (ledgerOf(client).last.get(preference) ?? 0) > mark;
}

/** Save one preference once every earlier save through this client has answered. */
export function savePreference(
  client: OperationsClient,
  preference: string,
  value: unknown,
): Promise<CallResult<CommandOutcome>> {
  const ledger = ledgerOf(client);
  ledger.made += 1;
  ledger.last.set(preference, ledger.made);
  const sent = ledger.tail.then(() => client.mutate('preference.save', { preference, value }));
  ledger.tail = sent.catch(() => null);
  return sent;
}
