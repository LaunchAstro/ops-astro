// SPDX-License-Identifier: AGPL-3.0-only
//
// The held address across businesses (MP-2-1, issue 74). A session ended on an
// address in one business and the person signed in to another. Whether to name
// that business is the server's answer: `session.capabilities` under its
// prefix, with the new bearer, answers only a person holding a live grant
// there. A refusal, or no answer, names no business.

import type { ReactElement } from 'react';
import { OperationsClient } from './operations/client.ts';
import type { Interruption, Session } from './session/token.ts';

export type HeldOffer =
  | { readonly kind: 'switch'; readonly businessKey: string; readonly address: string }
  | { readonly kind: 'unnamed' };

export async function heldAddressOffer(options: {
  readonly held: Interruption;
  readonly next: Session;
  readonly apiOrigin: string;
  readonly fetch: typeof globalThis.fetch;
}): Promise<HeldOffer> {
  const { held, next } = options;
  const probe = new OperationsClient({
    fetch: options.fetch,
    origin: options.apiOrigin,
    businessKey: held.businessKey,
    token: next.token,
  });
  const answer = await probe.read('session.capabilities', {});
  return 'ok' in answer
    ? { kind: 'switch', businessKey: held.businessKey, address: held.address }
    : { kind: 'unnamed' };
}

export function HeldAddressNotice(props: {
  readonly offer: HeldOffer | null;
  readonly signedInTo: string;
  readonly onSwitch: (businessKey: string, address: string) => void;
}): ReactElement {
  const offer = props.offer;
  if (offer?.kind !== 'switch') {
    return <>The address you were on belongs to a business you are not signed in to now.</>;
  }
  return (
    <>
      The address you were on belongs to {offer.businessKey}. You are signed in to{' '}
      {props.signedInTo}.{' '}
      <button
        className="btn btn--primary btn--sm"
        type="button"
        data-switch="held-address"
        onClick={() => {
          props.onSwitch(offer.businessKey, offer.address);
        }}
      >
        Switch to {offer.businessKey}
      </button>
    </>
  );
}
