// SPDX-License-Identifier: AGPL-3.0-only
//
// The sign-in page's code step (C59): the half-made sign-in a password opened, its code checked
// through the money step-up, and its sign-out when the step is cancelled or the page is left.
// Moved whole from screens/SignIn.tsx to keep that file under the line limit.

import { useEffect, useRef, useState } from 'react';
import { signOutOf, type ApiRoute, type AskedForCode } from './sign-in.ts';
import { stepUpSession } from './step-up.ts';

/** The code step: its field, its check through the step-up, and its cancel. */
export function useCodeStep(route: ApiRoute, open: (sessionId: string) => void) {
  const [asked, setAsked] = useState<AskedForCode | null>(null);
  const [code, setCode] = useState('');
  const [because, setBecause] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // Moved on by every check, cancel and unmount: an answer for an older one is dropped. The
  // half sign-in goes with its code step (Cancel, or the page left) unless a good code opened.
  const attempt = useRef(0);
  const opened = useRef(false);
  const leave = (client: AskedForCode['client'], sessionId?: string): void => {
    if (sessionId !== undefined)
      void signOutOf(route, { sessionId, businessKey: client.businessKey });
  };
  useEffect(
    () => () => {
      attempt.current += 1;
      if (asked !== null && !opened.current) leave(asked.client, asked.sessionId);
    },
    [asked],
  );
  const check = (): void => {
    if (asked === null) return;
    const mine = ++attempt.current;
    setChecking(true);
    setBecause(null);
    void (async () => {
      const { client, sessionId: from } = asked;
      const current = () => attempt.current === mine;
      const result = await stepUpSession({ code, client, route, from, current, adopt: () => {} });
      // A cancel or a leave landing as the new sign-in was finished signs that one out too.
      if (result.ok && !current()) leave(client, result.sessionId);
      if (!current()) return;
      setChecking(false);
      setCode('');
      if (result.ok) {
        opened.current = true;
        open(result.sessionId);
      } else setBecause(result.because);
    })();
  };
  const cancel = (): void => {
    attempt.current += 1;
    setAsked(null);
    setCode('');
    setBecause(null);
    setChecking(false);
  };
  return { asked, setAsked, attempt, leave, code, setCode, because, checking, check, cancel };
}
