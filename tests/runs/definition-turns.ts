// SPDX-License-Identifier: AGPL-3.0-only
//
// What the #1904 turn proofs share on the definition world
// (`definition-world.ts`): a turn sent through the real agent door with the
// provider's answer scripted, the messages the provider was sent for it, and
// the check that a refusal came before any hold: nothing sent, the one call
// recorded refused with its code, and the reservation's held minor as it was.

import { expect } from 'vitest';
import type { Answer } from '../api/fixture.ts';
import {
  asAgent,
  durable,
  signedIn,
  world,
  type Durable,
  type SignedIn,
} from './run-stop-door-world.ts';
import {
  definitionPart,
  ENTRY,
  ledgerOf,
  pinnedWork,
  sentSince,
  type Pinned,
} from './definition-world.ts';
import { detailOf, replied, taskPart, turnBody } from './turn-world.ts';

export interface Sent {
  readonly answer: Answer;
  /** Each request the provider was sent for this turn: its messages, as the broker made them. */
  readonly sent: readonly (readonly Record<string, unknown>[])[];
}

/** Turn `ordinal` on the pinned run's lease, with these parts, answered "Done." if it is sent. */
export async function sendTurn(
  on: Pinned,
  parts: readonly unknown[],
  as: SignedIn,
  ordinal = 0,
  key?: string,
): Promise<Sent> {
  world.provider.script([replied('Done.')]);
  const mark = world.provider.seen.length;
  const answer = await asAgent('/model/call', on.work, turnBody(on.work, ordinal, parts), as, key);
  return { answer, sent: sentSince(mark) };
}

/** The pinned run's rows and money before a turn, for `refusedBeforeAnyHold`. */
export const beforeTurn = async (on: Pinned): Promise<Durable> => await durable(on.work);

/** Refused `code` before any hold: nothing sent, one refused call, the held minor unchanged. */
export async function refusedBeforeAnyHold(
  on: Pinned,
  { answer, sent }: Sent,
  code: string,
  before: Durable,
): Promise<void> {
  expect(answer.body['code'], JSON.stringify(answer.body)).toBe(code);
  expect(sent, 'nothing was sent').toEqual([]);
  const after = await durable(on.work);
  expect(after.calls, 'no held call').toEqual([{ state: 'refused', refusal_code: code }]);
  expect(after.reservationHeldMinor, 'the reserved minor unchanged').toBe(
    before.reservationHeldMinor,
  );
  expect(after.envelopeActualMinor, 'nothing spent').toBe(before.envelopeActualMinor);
}

/** The turn settled, sent once. */
export function settledOnce({ answer, sent }: Sent): void {
  expect(detailOf(answer), JSON.stringify(answer.body)).toMatchObject({ state: 'settled' });
  expect(sent).toHaveLength(1);
}

/** The system message of the one request sent. */
export function systemOf({ sent }: Sent): Record<string, unknown> | undefined {
  return sent[0]?.[0];
}

/**
 * A [definition, task] turn on a fresh run that pinned the entry and never
 * read it: refused `PROVENANCE_UNBOUND` before any hold (P6). Its answer, the
 * body a crossing's refusal is compared with.
 */
export async function turnOnUnread(title: string): Promise<Answer> {
  const on = await pinnedWork(title);
  const before = await beforeTurn(on);
  const sent = await sendTurn(
    on,
    [definitionPart(ENTRY), await taskPart(on.work)],
    await signedIn(),
  );
  await refusedBeforeAnyHold(on, sent, 'PROVENANCE_UNBOUND', before);
  expect(await ledgerOf(on.runId)).toBe(0);
  return sent.answer;
}
