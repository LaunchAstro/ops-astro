// SPDX-License-Identifier: AGPL-3.0-only
//
// The reader's own availability changes (MP-7-10), in the order the person
// made them, whichever Team screen they were made on. One screen's changes
// leave one after another. Across screens, per sign-in (the client), only the
// newest choice counts: an older choice still waiting is never sent, and when
// an older request is answered after the newest one already was, the newest is
// sent once more, so the server's last stored choice is the person's last.

import type { AvailabilityChange } from '@launchastro/ui';
import type { CallResult, OperationsClient } from '../../operations/client.ts';

/** What a change does with its answer. */
export type Answered = (result: CallResult<unknown>) => void;

interface Newest {
  readonly number: number;
  readonly body: Readonly<Record<string, unknown>>;
  readonly answered: Answered;
  /** Its request has been answered, so an older answer after it would overwrite it. */
  landed: boolean;
}

const newestOf = new WeakMap<OperationsClient, Newest>();
let made = 0;

const settled = (): void => {};

/** What the panel asks for, as the command's body: away carries the reason, available carries none. */
const bodyOf = (change: AvailabilityChange): Readonly<Record<string, unknown>> =>
  change.away ? { state: 'away', reason: change.reason } : { state: 'available' };

async function send(
  client: OperationsClient,
  number: number,
  body: Readonly<Record<string, unknown>>,
): Promise<CallResult<unknown>> {
  const result = await client.setAvailability(body);
  const newest = newestOf.get(client);
  if (newest?.number === number) newest.landed = true;
  else if (newest?.landed === true) {
    // This older choice was stored after the newest: store the newest again.
    newest.landed = false;
    newest.answered(await send(client, newest.number, newest.body));
  }
  return result;
}

/** One Team screen's queue of changes, through `client`. */
export function availabilitySaver(client: OperationsClient) {
  let queue: Promise<unknown> = Promise.resolve();
  return (change: AvailabilityChange, answered: Answered): void => {
    made += 1;
    const newest: Newest = { number: made, body: bodyOf(change), answered, landed: false };
    newestOf.set(client, newest);
    const before = queue;
    queue = (async () => {
      await before;
      if (newestOf.get(client) === newest) answered(await send(client, newest.number, newest.body));
    })().catch(settled);
  };
}
