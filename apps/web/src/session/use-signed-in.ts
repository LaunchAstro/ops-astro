// SPDX-License-Identifier: AGPL-3.0-only
//
// What the application does when a sign-in lands: the session is kept, and the
// address held before it reopens only in the business it was held in. Moved
// whole from App.tsx to keep that file under the line limit.

import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { pathTo } from '../routes.ts';
import { heldAddressOffer, type HeldOffer } from '../held-address.tsx';
import type { AppProps } from '../app-props.ts';
import type { Interruption, Session } from './token.ts';

/** Why the board was reached instead of the address that was held, and the server's offer. */
export interface HeldNotice {
  readonly held: Interruption;
  readonly offer: HeldOffer | null;
}

export function useSignedIn(
  props: AppProps,
  setSession: (next: Session) => void,
  setNotice: Dispatch<SetStateAction<HeldNotice | null>>,
  setSignedOut: (value: boolean) => void,
): (next: Session) => void {
  return useCallback(
    (next: Session) => {
      // Spent here, so the next ordinary sign-in is not redirected by an
      // interruption somebody already answered.
      const back = props.sessions.takeInterruption();
      props.sessions.set(next);
      setSession(next);
      setNotice(null);
      setSignedOut(false);
      if (back === null) {
        props.navigate(pathTo('agency:projects-board'));
        return;
      }
      // **The held address only means anything in the business it was held
      // in.** A task key is business-local, so replaying the string under a
      // different business does not reopen the task the person was promised:
      // it refuses, or -- worse, because it looks like success -- it draws an
      // unrelated record that happens to share the key. A deliberate change of
      // business is not a mistake, so it is not refused; it goes to that
      // business's board and says why.
      if (back.businessKey === next.businessKey) {
        props.navigate(back.address);
        return;
      }
      setNotice({ held: back, offer: null });
      props.navigate(pathTo('agency:projects-board'));
      void heldAddressOffer({
        held: back,
        next,
        apiOrigin: props.apiOrigin,
        fetch: props.fetch,
      }).then((offer) => {
        // Only onto the notice it was asked for: a sign-out or a switch since
        // has replaced or cleared it.
        setNotice((current) => (current?.held === back ? { held: back, offer } : current));
        return offer;
      });
    },
    [props, setSession, setNotice, setSignedOut],
  );
}
