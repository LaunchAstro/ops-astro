// SPDX-License-Identifier: AGPL-3.0-only
//
// The email send operation (AW-07b): a catalogued operation like a model
// call, so it leaves the machine only through the broker and custody. Its
// twelve declarations are read the same way (`operation.ts`).
//
// An email tells a person where to go and nothing else. The adapter takes the
// recipient, the sender and one address, and builds a plain-text message with
// that address as its only link. It takes no subject text, no reason, no
// title and no gate: nothing in it names, approves or declines anything, so
// opening it, following it or a scanner fetching it can only land on a page
// where a person decides while signed in.
//
// The request is Resend's `POST /emails` shape. The fake provider
// (`email-fake.ts`) answers the same shape on loopback for CI and staging,
// and the SES swap stays behind the same seam.

import type { AdapterRequest, ModelAnswer, ModelOperationDeclaration } from './operation.ts';

export const EMAIL_PATH = '/emails';

/** The provider's own code for a message refused before any sending began. */
export const EMAIL_NOTHING_HAPPENED = 'rejected_before_sending';

/** The production destination, the one entry custody's list holds for mail. */
export const RESEND_DESTINATION = { key: 'email', origin: 'https://api.resend.com' } as const;

/** The only words an email carries besides its one address. */
export const EMAIL_SUBJECT = 'Something is waiting for you';

/** The message, built from the address alone. */
export function emailText(address: string): string {
  return [
    'Something is waiting for you.',
    '',
    `Open it here: ${address}`,
    '',
    'This email only tells you where to go. Nothing changes until you open it and choose.',
  ].join('\n');
}

/** Fields in, a request with neither origin nor credential out. The three are the declared fields. */
export function emailAdapter(values: Readonly<Record<string, string>>): AdapterRequest {
  const { to, from, address } = values;
  if (to === undefined || from === undefined || address === undefined) {
    throw new Error('email adapter: a declared field is missing');
  }
  return {
    path: EMAIL_PATH,
    method: 'POST',
    body: JSON.stringify({ from, to: [to], subject: EMAIL_SUBJECT, text: emailText(address) }),
  };
}

/** A provider message id: letters, digits and dashes, nothing that could carry more. */
const MESSAGE_ID = /^[A-Za-z0-9-]{1,64}$/u;

/**
 * The answer schema: exactly `{ "id": <message id> }`. Any other key, a
 * planted instruction or decision among them, makes the whole answer
 * malformed. The id is the only thing kept, as the attempt's evidence.
 */
export function readEmailAnswer(body: unknown): ModelAnswer | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const keys = Object.keys(body);
  const id = (body as Record<string, unknown>)['id'];
  if (keys.length !== 1 || typeof id !== 'string' || !MESSAGE_ID.test(id)) return undefined;
  return { text: id, model: null, usage: { inputUnits: 0, outputUnits: 0 }, providerCode: null };
}

/**
 * One email to one person. It settles at `accepted`: the provider taking the
 * message is all a send can know, and delivered comes only from the
 * provider's later event. Mail is paid by plan, not per message, so it is not
 * billed, and its priced maximum is the smallest the catalogue allows.
 */
export const EMAIL_SEND: ModelOperationDeclaration = {
  key: 'email.send',
  provider: 'resend',
  destination: RESEND_DESTINATION.key,
  fields: { to: 'personal', from: 'business_internal', address: 'business_internal' },
  answer: readEmailAnswer,
  timeoutMs: 10_000,
  maxResponseBytes: 4 * 1024,
  maximumMinor: 1,
  settlesAt: 'accepted',
  nothingHappened: [EMAIL_NOTHING_HAPPENED],
  billed: false,
  concurrency: 4,
};
