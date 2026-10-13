// SPDX-License-Identifier: AGPL-3.0-only
//
// A tab's question whose answer was lost: the server may have committed it,
// so its identity and its complete request are kept, and resending the same
// question presents exactly that request again. The server's register then
// replays the first attempt rather than starting a second conversation or
// posting a second message. Only a success of that same identity proves what
// the first attempt did, so only that clears it: a refusal of a replay may be
// today's rights answering a committed attempt, and the identity stays. A
// send whose own first answer was a refusal was never lost and keeps nothing.
// Held in the view for its life only, never in storage.

import { isRefusal, isUnavailable, type CallResult } from '../operations/client.ts';

/** What a send asks: its command, the question as typed, and the complete request. */
export interface Asked {
  readonly command: 'conversation.start' | 'conversation.message';
  readonly question: string;
  readonly request: Readonly<Record<string, unknown>>;
}

type Kept = Asked & { readonly operationId: string };

export interface Resends {
  /** Sends `asked` for tab `key`, under the kept identity and request when it is a resend. */
  send<T>(
    key: string,
    asked: Asked,
    write: (request: Asked['request'], operationId: string) => Promise<CallResult<T>>,
  ): Promise<CallResult<T>>;
}

export function resends(): Resends {
  const kept = new Map<string, Kept>();
  return {
    async send(key, asked, write) {
      const held = kept.get(key);
      const resent =
        held !== undefined && held.command === asked.command && held.question === asked.question;
      const sending: Kept = resent ? held : { ...asked, operationId: crypto.randomUUID() };
      const result = await write(sending.request, sending.operationId);
      // Each completion owns its own identity: an older send settling late
      // never clears, or takes the place of, another send's kept one.
      const now = kept.get(key);
      const success = !isUnavailable(result) && !isRefusal(result);
      if (success && now?.operationId === sending.operationId) kept.delete(key);
      else if (isUnavailable(result) && now === undefined) kept.set(key, sending);
      return result;
    },
  };
}
