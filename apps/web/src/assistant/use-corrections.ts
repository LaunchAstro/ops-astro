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
// **Keyed on business and grant.** Everything is held under the business it
// was asked in (`client.businessKey`) and the grant it was asked under (the
// view's `grantKey`: business, person and session), and every answer lands
// under the key its call went out for. A late answer never draws in another
// business's or another person's desks, even on a drawer that is not
// remounted, and the hook hands out the active key's corrections only.

import { useEffect, useRef, useState } from 'react';
import type {
  CorrectionListItem,
  LiveCorrectionListResult,
  LiveCorrectionReadResult,
  LiveCorrectionReceiptsResult,
} from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../operations/client.ts';
import { settle, type Failure, type Settlement } from '../records/use-command.ts';
import { cardState, refusalWords, type CorrectionAsk, type ProposePort } from './correction.ts';
import type { Correction } from './correction-desks.ts';

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

/** Every desk (business and grant), each changed under its own key only. */
function useHeld(): { readonly held: ReadonlyMap<string, Held>; change: Change; amend: Amend } {
  const [held, setHeld] = useState<ReadonlyMap<string, Held>>(new Map());
  const change: Change = (key, move) => {
    setHeld((now) => new Map(now).set(key, move(now.get(key) ?? EMPTY)));
  };
  const amend: Amend = (key, id, patch) => {
    change(key, (desk) => ({
      ...desk,
      list: desk.list.map((each) => (each.correctionId === id ? { ...each, ...patch } : each)),
    }));
  };
  return { held, change, amend };
}

/** A failure's code; an answer of the wrong shape is no answer. */
const failedCode = (settled: Settlement<unknown>): string =>
  settled.kind === 'ok' || settled.kind === 'unknown' ? 'UNAVAILABLE' : settled.refusal.code;

/** A read's or decision's failure in plain words, never its code. */
const failureWords = (failed: Failure): string => refusalWords(failedCode(failed));

/**
 * The correction's decision as `live_correction.read` answers it now, under
 * `key`; false where the read failed, its failure then the card's refusal.
 * `newest` says whether this read is still the latest sent for it; an
 * overtaken answer is dropped.
 */
async function readInto(
  client: OperationsClient,
  amend: Amend,
  key: string,
  correctionId: string,
  newest: () => boolean,
): Promise<boolean> {
  const settled = settle(
    await client.read<LiveCorrectionReadResult>('live_correction.read', { correctionId }),
  );
  if (!newest()) return settled.kind === 'ok';
  if (settled.kind !== 'ok') {
    amend(key, correctionId, { refusal: failureWords(settled) });
    return false;
  }
  const { state, approver, versionId } = settled.value.correction;
  amend(key, correctionId, { state: cardState(state), approver, versionId, refusal: null });
  return true;
}

/** `work`, counted busy on the desk under `key` while it runs. */
function tracked(change: Change, key: string, work: Promise<void>): void {
  change(key, (desk) => ({ ...desk, busy: desk.busy + 1 }));
  void work.finally(() => {
    change(key, (desk) => ({ ...desk, busy: desk.busy - 1 }));
  });
}

/** A listed correction as its card holds it; the page is named by its address. */
const listed = (item: CorrectionListItem): Correction => ({
  correctionId: item.correctionId,
  ask: { page: item.pageUrl, word: item.word, replacement: item.replacement },
  state: cardState(item.state),
  approver: item.approver,
  versionId: item.versionId,
  refusal: null,
  receipts: null,
});

/** A correction just asked for, before its first read answers. */
const askedOf = (correctionId: string, ask: CorrectionAsk): Correction => ({
  correctionId,
  ask,
  state: 'requested',
  approver: null,
  versionId: null,
  refusal: null,
  receipts: null,
});

/** The desk with the listed corrections it does not hold yet; one it holds is newer. */
const withListed = (desk: Held, items: readonly CorrectionListItem[]): Held => {
  const held = new Set(desk.list.map((each) => each.correctionId));
  const fresh = items.filter((item) => !held.has(item.correctionId)).map((item) => listed(item));
  return { ...desk, listRefusal: null, list: [...desk.list, ...fresh] };
};

/** The key a desk is held under: the business, then the grant on top. */
const deskKey = (business: string, grantKey: string | undefined): string =>
  JSON.stringify([business, grantKey ?? null]);

/** Fills the desk under `at` from `live_correction.list` once, when it is first drawn. */
function useListed(client: OperationsClient, at: string, change: Change): void {
  useEffect(() => {
    const listing = async (): Promise<void> => {
      const settled = settle(
        await client.read<LiveCorrectionListResult>('live_correction.list', {}),
      );
      // A person with no grant on corrections is shown no desks, not a refusal.
      if (settled.kind === 'closed') return;
      // An answer without a list is said as no answer, never drawn or thrown on.
      const items = settled.kind === 'ok' ? settled.value.corrections : null;
      change(at, (desk) =>
        Array.isArray(items)
          ? withListed(desk, items)
          : { ...desk, listRefusal: refusalWords(failedCode(settled)) },
      );
    };
    void listing();
    // Read once for each desk; `change` only sets state, so the first one serves.
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

/** `readInto`, counting the reads sent for each desk and correction so only the newest lands. */
function useNewestRead(
  client: OperationsClient,
  amend: Amend,
): (key: string, id: string) => Promise<boolean> {
  const sent = useRef(new Map<string, number>());
  return (key, id) => {
    const which = JSON.stringify([key, id]);
    const nth = (sent.current.get(which) ?? 0) + 1;
    sent.current.set(which, nth);
    return readInto(client, amend, key, id, () => sent.current.get(which) === nth);
  };
}

export function useCorrections(
  client: OperationsClient,
  propose: ProposePort | undefined,
  grantKey?: string,
): Corrections {
  const { held, change, amend } = useHeld();
  const at = deskKey(client.businessKey, grantKey);
  const mine = held.get(at) ?? EMPTY;
  const read = useNewestRead(client, amend);
  useListed(client, at, change);
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
    const fresh = await read(key, id);
    if (settled.kind !== 'ok' && fresh) amend(key, id, { refusal: failureWords(settled) });
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
    openReceipts: (id) => {
      tracked(change, at, receiptsInto(client, amend, at, id));
    },
  };
}
