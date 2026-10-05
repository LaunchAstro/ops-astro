// SPDX-License-Identifier: AGPL-3.0-only
//
// The fake sending-domain source (AW-07b sender): the provider's domain
// answer and the root's DMARC records, made up, for CI and staging until the
// owner says yes to a provider account (owner line 68). Every report drawn
// from it is marked `mock`. It holds no network primitive.

import type { SenderSource } from './email-sender.ts';

export interface FakeSenderState {
  /** The name the answer carries; the subdomain it was set up for, unless a case says otherwise. */
  name: string;
  dkim: string;
  spf: string;
  returnPathMx: string;
  /** The root's `_dmarc` TXT records. */
  dmarc: string[];
  /** A raw answer in place of the built one: a hostile or malformed case. */
  raw?: unknown;
}

/** A source answering from `state`, read at each check, so a case can move it. */
export function fakeSenderSource(state: FakeSenderState): SenderSource {
  return {
    mock: true,
    domain: async () =>
      await Promise.resolve(
        state.raw ?? {
          object: 'domain',
          name: state.name,
          records: [
            { record: 'SPF', name: 'send', type: 'MX', status: state.returnPathMx, priority: 10 },
            { record: 'SPF', name: 'send', type: 'TXT', status: state.spf },
            { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', status: state.dkim },
          ],
        },
      ),
    dmarc: async () => await Promise.resolve([...state.dmarc]),
  };
}
