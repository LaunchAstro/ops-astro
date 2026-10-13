// SPDX-License-Identifier: AGPL-3.0-only
//
// The real sending-domain source (on-email rules 5 and 9): the provider's
// domain answer, read through custody on the one GET route the `email`
// destination lists, `/domains/<id>`, with the key custody alone holds. The
// broker's process sends custody a path and reads back a body; the key never
// crosses. The root's DMARC records come from DNS, which needs no key: the
// entry that starts the mail unit hands in its TXT reader, so this module
// holds no network primitive of its own.
//
// Anything but a 2xx JSON answer throws, and `checkSender` reads a throw as
// not verified. So does a DNS fault on `_dmarc`; only a root with no such
// record reads as none, since DMARC is reported beside the three records,
// never required.

import type { SenderSource } from '../../core-connectors/src/index.ts';
import type { Custody } from './custody.ts';

/** What the provider's domain read is sent with: the credential, its destination, and the domain. */
export interface DomainRead {
  readonly credentialRef: string;
  readonly destination: string;
  readonly domainId: string;
}

const DOMAIN_READ_TIMEOUT_MS = 10_000;
const DOMAIN_READ_MAX_BYTES = 16 * 1024;
/** DNS answers that mean the name holds no record, as against a lookup that failed. */
const NO_RECORD = new Set(['ENOTFOUND', 'ENODATA']);

/** A source reading the provider through `custody`, and the root's TXT records through `txt`. */
export function custodySenderSource(
  custody: Custody,
  read: DomainRead,
  txt: (name: string) => Promise<string[][]>,
): SenderSource {
  return {
    mock: false,
    domain: async () => {
      const outcome = await custody.dispatch(read.credentialRef, {
        destination: read.destination,
        method: 'GET',
        path: `/domains/${read.domainId}`,
        body: '',
        timeoutMs: DOMAIN_READ_TIMEOUT_MS,
        maxResponseBytes: DOMAIN_READ_MAX_BYTES,
      });
      if (outcome.kind !== 'answered' || !outcome.outbound.ok) {
        throw new Error('sending domain: no answer from the provider');
      }
      return JSON.parse(outcome.outbound.body) as unknown;
    },
    dmarc: async (root) => {
      try {
        return (await txt(`_dmarc.${root}`)).map((chunks) => chunks.join(''));
      } catch (error) {
        if (NO_RECORD.has((error as { code?: unknown }).code as string)) return [];
        throw error;
      }
    },
  };
}
