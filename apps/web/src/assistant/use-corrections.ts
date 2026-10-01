// SPDX-License-Identifier: AGPL-3.0-only
//
// C80: the sidebar chat's correction request, on the drawer's own store.
//
// A line that reads as a one-word change (`readCorrectionAsk`) takes this
// path instead of the conversation: the person's grants are read first
// (`session.capabilities`), and without `run:write` the drawer says so and
// asks no desk, so no card is drawn. With it, the desk's answer is drawn as
// the agent's line with the card under it, or as a refusal in the server's
// own words. A made-up desk's lines carry `provenance: 'mock'`; the grant
// read is real, so its refusal never does.

import { useRef } from 'react';
import type { AssistantMessage } from '@launchastro/ui';
import type { CapabilitiesResult } from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../operations/client.ts';
import { settle } from '../records/use-command.ts';
import { said, type AssistantState } from './chats.ts';
import {
  amended,
  holdsRunWrite,
  NOT_GRANTED,
  readCorrectionAsk,
  type CorrectionDesk,
  type DeskAnswer,
} from './correction.ts';

export const ASKED_FOR =
  'Asked for this change. The site changes only once the configured approver approves this exact version.';

type Line = Omit<AssistantMessage, 'id' | 'cites'>;

export interface Corrections {
  /** True when the line was a correction request and is handled here. */
  readonly ask: (key: string, text: string) => boolean;
  readonly check: (key: string, messageId: string) => void;
}

/** Whether the person holds `run:write`, or why that is not known. */
async function granted(client: OperationsClient): Promise<string | null> {
  const settled = settle(await client.read<CapabilitiesResult>('session.capabilities', {}));
  if (settled.kind === 'ok') return holdsRunWrite(settled.value.grants) ? null : NOT_GRANTED;
  return settled.kind === 'closed' ? NOT_GRANTED : settled.because;
}

export function useCorrections(
  client: OperationsClient,
  desk: CorrectionDesk,
  update: (move: (state: AssistantState) => AssistantState) => void,
): Corrections {
  const count = useRef(0);
  const asked = useRef(new Map<string, string>());
  const mark: Pick<Line, 'provenance'> = desk.provenance === 'mock' ? { provenance: 'mock' } : {};
  const put = (key: string, line: Line): string => {
    count.current += 1;
    const id = `correction-${String(count.current)}`;
    update((state) => said(state, key, { id, cites: [], ...line }));
    return id;
  };
  const answer = (key: string, reply: DeskAnswer): void => {
    if (reply.kind === 'refused') {
      put(key, { role: 'failed', body: reply.because, ...mark });
      return;
    }
    const id = put(key, { role: 'ai', body: ASKED_FOR, correction: reply.correction, ...mark });
    asked.current.set(id, reply.correctionId);
  };
  const request = async (key: string, text: string): Promise<void> => {
    const wanted = readCorrectionAsk(text);
    if (wanted === null) return;
    const refusal = await granted(client);
    if (refusal === null) answer(key, await desk.request(wanted));
    else put(key, { role: 'failed', body: refusal });
  };
  const recheck = async (key: string, messageId: string): Promise<void> => {
    const id = asked.current.get(messageId);
    if (id === undefined || desk.recheck === undefined) return;
    const reply = await desk.recheck(id);
    if (reply.kind === 'card') {
      update((state) => amended(state, key, messageId, reply.correction));
    } else answer(key, reply);
  };
  return {
    ask: (key, text) => {
      if (readCorrectionAsk(text) === null) return false;
      put(key, { role: 'user', body: text });
      void request(key, text);
      return true;
    },
    check: (key, messageId) => {
      void recheck(key, messageId);
    },
  };
}
