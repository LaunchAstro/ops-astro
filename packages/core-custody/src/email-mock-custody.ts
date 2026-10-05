// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b's mock delivery, with SEC10 A2 kept: a setup report drawn from the
// fake sender source (`mock`) never verifies a real send. The one send a mock
// report may verify goes through a custody this module started, for one
// destination on this machine (127.0.0.0/8 or [::1]), so a made-up setup check
// can only ever reach a made-up provider.
//
// The mark is this module's own: the custody object it started, held in a
// WeakSet. No setting, copy or wrapper of a custody carries it, so
// configuration alone never turns a real provider into the mock one. A
// loopback origin proves where the provider is, not what listens there: a
// local proxy to a real provider, or a real key in the credentials file, is
// outside this guard.
//
// A send over this custody is recorded `mock:<id>`, never `provider:<id>`
// (`isLoopbackMock`), so a mock acceptance never reads as a provider's.

import { startCustody, type Custody } from './custody.ts';
import { fromVerifiedSender } from './email-class.ts';
import type { Destination } from './egress.ts';

const LOOPBACK_HOST = /^(?:127(?:\.\d{1,3}){3}|\[::1\])$/u;
const loopbackMock = new WeakSet<Custody>();

/** True for an origin whose host is this machine's loopback address, written as an IP. */
export function onThisMachine(origin: string): boolean {
  try {
    return LOOPBACK_HOST.test(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Custody for the mock provider: one destination, on this machine, marked as the
 * loopback mock. Any other origin is refused before custody starts.
 */
export async function startLoopbackMockCustody(
  credentialsFile: string,
  destination: Destination,
): Promise<Custody> {
  if (!onThisMachine(destination.origin)) {
    throw new Error('mock mail custody: the provider origin is not on this machine');
  }
  const custody = await startCustody({ credentialsFile, destinations: [destination] });
  loopbackMock.add(custody);
  return custody;
}

/** True only for a custody `startLoopbackMockCustody` started: its sends reach the mock provider. */
export function isLoopbackMock(custody: Custody): boolean {
  return loopbackMock.has(custody);
}

/**
 * The sender gate as one send sees it: a mock report counts as unmocked only
 * when the send's custody is the loopback mock this module started; over any
 * other custody it is refused, as `fromVerifiedSender` refuses every mock report.
 */
export function senderVerifiedFor(
  from: string,
  sender: Parameters<typeof fromVerifiedSender>[1],
  custody: Custody,
): boolean {
  const mockHere = sender.mock && isLoopbackMock(custody);
  return fromVerifiedSender(from, mockHere ? { ...sender, mock: false } : sender);
}
