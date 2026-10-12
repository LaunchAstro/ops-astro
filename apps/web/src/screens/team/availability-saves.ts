// SPDX-License-Identifier: AGPL-3.0-only
//
// The reader's own availability changes (MP-7-10), in the order the person
// made them, whichever Team screen they were made on. One screen's changes
// leave one after another, each through the sign-in current when it was made.
// Across screens, per reader (the grant key, which a step-up keeps), only the
// newest choice counts: an older choice still waiting is never sent, and when
// an older request is answered after the newest one was sent, the newest is sent
// once more after its own answer, so the server's last stored choice is the
// person's last. The server's own order check is #541's server half.

import type { AvailabilityChange } from '@launchastro/ui';
import type { CallResult, OperationsClient } from '../../operations/client.ts';

/** What a change does with its answer. */
export type Answered = (result: CallResult<unknown>) => void;

interface Newest {
  readonly number: number;
  /** The sign-in it was made under: its request, and any repeat, go through it. */
  readonly client: OperationsClient;
  readonly body: Readonly<Record<string, unknown>>;
  readonly answered: Answered;
  /** Its request has left, so an older one answered from now on may have overwritten it. */
  sent: boolean;
  /** Its request has been answered. */
  landed: boolean;
  /** An older request was answered after this one left: send this one once more. */
  owed: boolean;
}

const newestOf = new Map<string, Newest>();
let made = 0;

const settled = (): void => {};

/** What the panel asks for, as the command's body: away carries the reason, available carries none. */
const bodyOf = (change: AvailabilityChange): Readonly<Record<string, unknown>> =>
  change.away ? { state: 'away', reason: change.reason } : { state: 'available' };

async function send(
  reader: string,
  client: OperationsClient,
  number: number,
  body: Readonly<Record<string, unknown>>,
): Promise<CallResult<unknown>> {
  const mine = newestOf.get(reader);
  if (mine?.number === number) mine.sent = true;
  const result = await client.setAvailability(body);
  const newest = newestOf.get(reader);
  if (newest === undefined || !newest.sent) return result;
  if (newest.number === number) newest.landed = true;
  else newest.owed = true;
  if (newest.owed && newest.landed) {
    // An older choice was stored after the newest left: store the newest again.
    newest.owed = false;
    newest.landed = false;
    newest.answered(await send(reader, newest.client, newest.number, newest.body));
  }
  return result;
}

/** One Team screen's queue of changes, each sent through the reader's sign-in current at the time. */
export function availabilitySaver() {
  let queue: Promise<unknown> = Promise.resolve();
  return (
    client: OperationsClient,
    reader: string,
    change: AvailabilityChange,
    answered: Answered,
  ): void => {
    made += 1;
    const newest: Newest = {
      number: made,
      client,
      body: bodyOf(change),
      answered,
      sent: false,
      landed: false,
      owed: false,
    };
    newestOf.set(reader, newest);
    const before = queue;
    queue = (async () => {
      await before;
      if (newestOf.get(reader) !== newest) return;
      answered(await send(reader, client, newest.number, newest.body));
    })().catch(settled);
  };
}
