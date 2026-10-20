// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 (P30): the sidebar's corrections, kept per business and grant.
//
// A request goes through the host's `ProposePort` and nowhere else; a refusal
// is said in plain words (`refusalWords`). An asked correction is then read
// with `live_correction.read`, which answers its state, its approver and the
// version a decision names. A decision is a person's approve or decline
// through `live_correction.decide` on that version, then read again whatever
// it answered, so a refused or unanswered decision draws the state and version
// the read answers now; its refusal is said in the same plain words.
//
// **When it was read.** Each read's answer is stamped with `performance.now()`
// as the read was sent (`readAt`), beside how long its version's check holds
// (`verifiedForMs`), so the card times its Approve from the read and never
// from the wall clock, and a slow answer grants no extra time. The card reads
// again through `reread`.
//
// **Keyed on business and grant.** Everything is held under the business it
// was asked in (`client.businessKey`) and the grant it was asked under (the
// view's `grantKey`: business, person and session), and every answer lands
// under the key its call went out for. A late answer never draws in another
// business's or another person's desks, even on a drawer that is not
// remounted, and the hook hands out the active key's corrections only.
//
// **In order.** A desk reads `live_correction.list` each time it is drawn,
// and an approved card reads its correction again until a final state. Each
// answer, a refusal included, lands unless one sent after it landed first
// (`correction-order.ts`), and the list counts as a read of every correction it
// carries. The list names no check, so a card it lists at a new version waits
// for a read of that version before Approve (`correction-list.ts`). A decision's refusal is said with the read that follows it, so it
// lands or is dropped with that read.

import { useEffect, useState } from 'react';
import type {
  LiveCorrectionListResult,
  LiveCorrectionReadResult,
  LiveCorrectionReceiptsResult,
} from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../operations/client.ts';
import { settle, type Failure, type Settlement } from '../records/use-command.ts';
import { cardState, refusalWords, type CorrectionAsk, type ProposePort } from './correction.ts';
import type { Correction } from './correction-desks.ts';
import { withListed } from './correction-list.ts';
import { useOrder, type Order } from './correction-order.ts';

export interface Corrections {
  readonly list: readonly Correction[];
  /** The door's last refusal, in plain words. */
  readonly refusal: string | null;
  /** The list read's refusal, in plain words. */
  readonly listRefusal: string | null;
  readonly busy: boolean;
  /** Present only where the host hands in a request port: without it no door is drawn. */
  readonly request?: (ask: CorrectionAsk) => void;
  readonly decide: (correctionId: string, decision: 'approve' | 'reject') => void;
  readonly openReceipts: (correctionId: string) => void;
  /** Read the correction again, under the business and grant it is held under. */
  readonly reread: (correctionId: string) => void;
}

/** How often an approved or accepted card reads its correction again. */
export const FOLLOW_MS = 3000;

interface Held {
  readonly list: readonly Correction[];
  readonly refusal: string | null;
  readonly listRefusal: string | null;
  readonly busy: number;
}

const EMPTY: Held = { list: [], refusal: null, listRefusal: null, busy: 0 };

type Change = (key: string, move: (desk: Held) => Held) => void;
type Amend = (key: string, correctionId: string, patch: Partial<Correction>) => void;

/** Every desk (business and grant), each changed under its own key only, and its answers' order. */
function useHeld(): {
  readonly held: ReadonlyMap<string, Held>;
  change: Change;
  amend: Amend;
  order: Order;
} {
  const [held, setHeld] = useState<ReadonlyMap<string, Held>>(new Map());
  const order = useOrder();
  const change: Change = (key, move) => {
    setHeld((now) => new Map(now).set(key, move(now.get(key) ?? EMPTY)));
  };
  const amend: Amend = (key, id, patch) => {
    change(key, (desk) => ({
      ...desk,
      list: desk.list.map((each) => (each.correctionId === id ? { ...each, ...patch } : each)),
    }));
  };
  return { held, change, amend, order };
}

/** A failure's code; an answer of the wrong shape is no answer. */
const failedCode = (settled: Settlement<unknown>): string =>
  settled.kind === 'ok' || settled.kind === 'unknown' ? 'UNAVAILABLE' : settled.refusal.code;

/** A read's or decision's failure in plain words, never its code. */
const failureWords = (failed: Failure): string => refusalWords(failedCode(failed));

/**
 * The correction's decision as `live_correction.read` answers it now, under
 * `key`, with `said` (a decision's refusal) as the card's refusal; false where
 * the read failed, its failure then the refusal instead. The answer is timed
 * from when the read was sent, so a slow answer grants no extra time. `lands`
 * says whether its answer may still land; an overtaken one, a refusal
 * included, is dropped.
 */
async function readInto(
  client: OperationsClient,
  amend: Amend,
  key: string,
  correctionId: string,
  lands: () => boolean,
  said: string | null,
): Promise<boolean> {
  const sentAt = performance.now();
  const settled = settle(
    await client.read<LiveCorrectionReadResult>('live_correction.read', { correctionId }),
  );
  if (!lands()) return settled.kind === 'ok';
  if (settled.kind !== 'ok') {
    amend(key, correctionId, { refusal: failureWords(settled) });
    return false;
  }
  const { state, approver, versionId, verifiedForMs, refusal } = settled.value.correction;
  amend(key, correctionId, {
    state: cardState(state),
    approver,
    versionId,
    verifiedForMs: Number.isFinite(verifiedForMs) && verifiedForMs > 0 ? verifiedForMs : 0,
    readAt: sentAt,
    reason: typeof refusal === 'string' ? refusal : null,
    refusal: said,
  });
  return true;
}

/** `work`, counted busy on the desk under `key` while it runs. */
function tracked(change: Change, key: string, work: Promise<void>): void {
  change(key, (desk) => ({ ...desk, busy: desk.busy + 1 }));
  void work.finally(() => {
    change(key, (desk) => ({ ...desk, busy: desk.busy - 1 }));
  });
}

/** A correction just asked for, before its first read answers. */
const askedOf = (correctionId: string, ask: CorrectionAsk): Correction => ({
  correctionId,
  ask,
  state: 'requested',
  approver: null,
  versionId: null,
  verifiedForMs: 0,
  readAt: null,
  reason: null,
  refusal: null,
  reviewMissingFor: null,
  receipts: null,
});

/** The key a desk is held under: the business, then the grant on top. */
const deskKey = (business: string, grantKey: string | undefined): string =>
  JSON.stringify([business, grantKey ?? null]);

/** Fills the desk under `at` from `live_correction.list` each time it is drawn. */
function useListed(client: OperationsClient, at: string, change: Change, order: Order): void {
  useEffect(() => {
    const listing = async (): Promise<void> => {
      const nth = order.next();
      const settled = settle(
        await client.read<LiveCorrectionListResult>('live_correction.list', {}),
      );
      // A person with no grant on corrections is shown no desks, not a refusal.
      if (settled.kind === 'closed') return;
      // An answer without a list is said as no answer, never drawn or thrown on.
      const items = settled.kind === 'ok' ? settled.value.corrections : null;
      if (!Array.isArray(items)) {
        change(at, (desk) => ({ ...desk, listRefusal: refusalWords(failedCode(settled)) }));
        return;
      }
      const landing = items.filter((item) => order.lands(at, item.correctionId, nth));
      change(at, (desk) => ({ ...desk, listRefusal: null, list: withListed(desk.list, landing) }));
    };
    void listing();
    // Read each time the desk is drawn; `change` and `order` only set state, so the first serve.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [at]);
}

/** Reads each approved or accepted correction under `at` again every `FOLLOW_MS`. */
function useFollowing(
  list: readonly Correction[],
  at: string,
  read: (key: string, id: string) => Promise<boolean>,
): void {
  const following = list
    .filter((each) => each.state === 'approved')
    .map((each) => each.correctionId)
    .join(' ');
  useEffect(() => {
    if (following === '') return;
    const timer = setInterval(() => {
      for (const id of following.split(' ')) void read(at, id);
    }, FOLLOW_MS);
    return () => {
      clearInterval(timer);
    };
    // The timer restarts only when the desk or the followed corrections change.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [at, following]);
}

/** A correction's receipts, under `key`, or the read's failure as the card's refusal. */
async function receiptsInto(
  client: OperationsClient,
  amend: Amend,
  key: string,
  correctionId: string,
): Promise<void> {
  const settled = settle(
    await client.read<LiveCorrectionReceiptsResult>('live_correction.receipts', { correctionId }),
  );
  amend(
    key,
    correctionId,
    settled.kind === 'ok' && Array.isArray(settled.value.receipts)
      ? { receipts: settled.value.receipts, refusal: null }
      : { refusal: refusalWords(failedCode(settled)) },
  );
}

/** `readInto`, in `order`: an answer overtaken by a newer one already landed is dropped. */
const orderedRead =
  (client: OperationsClient, amend: Amend, order: Order) =>
  (key: string, id: string, said: string | null = null): Promise<boolean> => {
    const nth = order.next();
    return readInto(client, amend, key, id, () => order.lands(key, id, nth), said);
  };

export function useCorrections(
  client: OperationsClient,
  propose: ProposePort | undefined,
  grantKey?: string,
): Corrections {
  const { held, change, amend, order } = useHeld();
  const at = deskKey(client.businessKey, grantKey);
  const mine = held.get(at) ?? EMPTY;
  const read = orderedRead(client, amend, order);
  useListed(client, at, change, order);
  useFollowing(mine.list, at, read);
  const request = async (key: string, ask: CorrectionAsk, port: ProposePort): Promise<void> => {
    const answer = await port(ask);
    if (!answer.ok) {
      change(key, (desk) => ({ ...desk, refusal: refusalWords(answer.code) }));
      return;
    }
    const asked = askedOf(answer.correctionId, ask);
    change(key, (desk) => ({ ...desk, refusal: null, list: [asked, ...desk.list] }));
    await read(key, answer.correctionId);
  };
  const decide = async (key: string, id: string, decision: 'approve' | 'reject'): Promise<void> => {
    const versionId = mine.list.find((each) => each.correctionId === id)?.versionId;
    if (versionId === null || versionId === undefined) return;
    const settled = settle(
      await client.mutate('live_correction.decide', { correctionId: id, versionId, decision }),
    );
    if (failedCode(settled) === 'ASTRA_REVIEW_MISSING')
      amend(key, id, { reviewMissingFor: versionId });
    await read(key, id, settled.kind === 'ok' ? null : failureWords(settled));
  };
  return {
    list: mine.list,
    refusal: mine.refusal,
    listRefusal: mine.listRefusal,
    busy: mine.busy > 0,
    ...(propose === undefined
      ? {}
      : {
          request: (ask: CorrectionAsk) => {
            tracked(change, at, request(at, ask, propose));
          },
        }),
    decide: (id, decision) => {
      tracked(change, at, decide(at, id, decision));
    },
    openReceipts: (id) => tracked(change, at, receiptsInto(client, amend, at, id)),
    reread: (id) => void read(at, id),
  };
}
