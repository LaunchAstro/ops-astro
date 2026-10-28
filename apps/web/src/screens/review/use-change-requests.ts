// SPDX-License-Identifier: AGPL-3.0-only
//
// The change-request panel's reads and writes (C57 part C, #2119). It reads `review.read` and
// `session.capabilities`; a decision (`review.decide_change`) or a filing
// (`review.propose_change`) reads the review again whatever it came to, so the panel draws what
// the server holds, never what was asked for.
//
// One operation id per intent: the id for a request's decision, or a pin's filing in these
// words, is minted on the first press and sent again on a retry after no answer, so a lost
// response cannot decide or file twice; a known answer ends the intent. Every answer is tagged
// with its read and the business and review it was asked in, and dropped when a newer read is
// out or the panel has moved to another business or review, which also clears what it drew.

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ReviewReadResult,
  SessionCapabilities,
} from '../../../../../packages/core-wire/src/index.ts';
import type { CallResult, CommandOutcome, OperationsClient } from '../../operations/client.ts';
import { isRefusal } from '../../operations/results.ts';
import { describeFailure } from '../../records/submit.ts';
import { settle } from '../../records/use-command.ts';
import { AGENT_WAIT, waitsOnLocalModel, type DockLoad } from './change-requests.ts';

export type DockClient = Pick<
  OperationsClient,
  'businessKey' | 'newOperationId' | 'read' | 'mutate'
>;

export interface ChangeRequestModel {
  readonly load: DockLoad;
  readonly canDecide: boolean;
  readonly busy: string | null;
  readonly note: string | null;
  readonly decide: (changeRequestId: string, decision: 'approve' | 'refuse') => void;
  readonly file: (commentId: string, text: string) => void;
}

interface Drawn extends Omit<ChangeRequestModel, 'decide' | 'file'> {
  /** The client, business and review the state was read in. */
  readonly scope: string;
  /** Which entry into that scope it is: every write and read is tagged with it. */
  readonly visit: number;
}

type Write = (operationId: string) => Promise<CallResult<CommandOutcome>>;

const blank = (scope: string, visit: number): Drawn => ({
  scope,
  visit,
  load: { kind: 'loading' },
  canDecide: false,
  busy: null,
  note: null,
});

async function readLoad(client: DockClient, reviewId: string): Promise<DockLoad> {
  const result = await client.read<ReviewReadResult>('review.read', { reviewId });
  if (!('ok' in result)) return { kind: 'refused', because: describeFailure(result) ?? '' };
  const { changeRequests, pins } = result.value.review;
  return { kind: 'ready', requests: changeRequests, pins };
}

/** Whether the reader holds `proposal:decide` anywhere; the server still decides each press. */
async function readCanDecide(client: DockClient): Promise<boolean> {
  const result = await client.read<SessionCapabilities>('session.capabilities', {});
  return (
    'ok' in result &&
    result.value.grants.some(
      (grant) => grant.collection === 'proposal' && grant.action === 'decide',
    )
  );
}

/** What a write leaves on the panel: nothing, the local-model wait, or the server's words. */
function noteOf(result: CallResult<CommandOutcome>): string | null {
  const settled = settle(result);
  if (settled.kind === 'ok') return null;
  return isRefusal(result) && waitsOnLocalModel(result.code) ? AGENT_WAIT : settled.because;
}

const clients = new WeakMap<DockClient, number>();
let lastClient = 0;

/** One number per client object: another person's session is another client, so another scope. */
function clientKey(client: DockClient): number {
  const known = clients.get(client);
  if (known !== undefined) return known;
  lastClient += 1;
  clients.set(client, lastClient);
  return lastClient;
}

/**
 * The state drawn for `scope`, cleared with its intents the moment the scope changes. Each
 * scope entered is a new visit, so a return to an earlier review is not the visit it left.
 */
function useScoped(scope: string) {
  const [drawn, setDrawn] = useState<Drawn>(() => blank(scope, 0));
  const visit = drawn.scope === scope ? drawn.visit : drawn.visit + 1;
  const latest = useRef({ visit, read: 0 });
  latest.current.visit = visit;
  const intents = useRef(new Map<string, string>());
  if (drawn.scope !== scope) {
    intents.current = new Map();
    setDrawn(blank(scope, visit));
  }
  const update = useCallback((asked: number, change: Partial<Drawn>) => {
    if (latest.current.visit === asked)
      setDrawn((state) => (state.visit === asked ? { ...state, ...change } : state));
  }, []);
  return { current: drawn.visit === visit ? drawn : blank(scope, visit), latest, intents, update };
}

/** `changes` is the host's own read of the review: each new one reads the panel again. */
export function useChangeRequests(
  client: DockClient,
  reviewId: string,
  changes?: unknown,
): ChangeRequestModel {
  const scope = `${String(clientKey(client))}\u0000${client.businessKey}\u0000${reviewId}`;
  const { current, latest, intents, update } = useScoped(scope);
  const { visit } = current;
  const reread = useCallback(async () => {
    // A write answered after the panel moved on reads nothing, so it cannot drop the new read.
    if (latest.current.visit !== visit) return;
    const read = (latest.current.read += 1);
    const load = await readLoad(client, reviewId);
    if (latest.current.read === read) update(visit, { load });
  }, [client, reviewId, visit, latest, update]);

  useEffect(() => {
    void reread();
    void readCanDecide(client).then((canDecide) => update(visit, { canDecide }));
  }, [client, visit, reread, update, changes]);

  const send = useCallback(
    async (intent: string, busy: string, write: Write) => {
      if (current.busy !== null) return;
      // This visit's intents: a later visit's map is never written by this write.
      const held = intents.current;
      const operationId = held.get(intent) ?? client.newOperationId();
      held.set(intent, operationId);
      update(visit, { busy, note: null });
      const result = await write(operationId);
      if (!('unavailable' in result)) held.delete(intent);
      if (latest.current.visit !== visit) return;
      update(visit, { busy: null, note: noteOf(result) });
      await reread();
    },
    [client, current.busy, intents, latest, reread, visit, update],
  );

  const decide = (changeRequestId: string, decision: 'approve' | 'refuse'): void => {
    void send(`decide\u0000${changeRequestId}\u0000${decision}`, changeRequestId, (operationId) =>
      client.mutate('review.decide_change', { changeRequestId, decision }, { operationId }),
    );
  };
  const file = (commentId: string, text: string): void => {
    void send(`file\u0000${commentId}\u0000${text}`, commentId, (operationId) =>
      client.mutate('review.propose_change', { commentId, text }, { operationId }),
    );
  };
  return { ...current, decide, file };
}
