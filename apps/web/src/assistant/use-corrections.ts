// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 (P30): the sidebar's corrections, kept per business.
//
// A request goes through the host's `ProposePort` and nowhere else; a refusal
// is said in plain words (`refusalWords`). An asked correction is then read
// with `live_correction.read`, which answers its state, its approver and the
// version a decision names. A decision is a person's approve or decline
// through `live_correction.decide` on that version, then read again; its
// refusal is said in the same plain words.
//
// **Keyed on business.** Everything is held under the business it was asked
// in (`client.businessKey`), and every answer lands under the business its
// call went out for, so a late answer never draws in another business's
// desks and the hook hands out the active business's corrections only.

import { useState } from 'react';
import type { LiveCorrectionReadResult } from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../operations/client.ts';
import { settle, type Failure } from '../records/use-command.ts';
import { cardState, refusalWords, type CorrectionAsk, type ProposePort } from './correction.ts';
import type { Correction } from './correction-desks.ts';

export interface Corrections {
  readonly list: readonly Correction[];
  /** The door's last refusal, in plain words. */
  readonly refusal: string | null;
  readonly busy: boolean;
  readonly request: (ask: CorrectionAsk) => void;
  readonly decide: (correctionId: string, decision: 'approve' | 'reject') => void;
}

interface Held {
  readonly list: readonly Correction[];
  readonly refusal: string | null;
  readonly busy: number;
}

const EMPTY: Held = { list: [], refusal: null, busy: 0 };

type Change = (key: string, move: (desk: Held) => Held) => void;
type Amend = (key: string, correctionId: string, patch: Partial<Correction>) => void;

/** Every business's desks, each changed under its own key only. */
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

/** A read's or decision's failure in plain words, never its code. */
const failureWords = (failed: Failure): string =>
  refusalWords(failed.kind === 'unknown' ? 'UNAVAILABLE' : failed.refusal.code);

/** The correction's decision as `live_correction.read` answers it now, under `key`. */
async function readInto(
  client: OperationsClient,
  amend: Amend,
  key: string,
  correctionId: string,
): Promise<void> {
  const settled = settle(
    await client.read<LiveCorrectionReadResult>('live_correction.read', { correctionId }),
  );
  if (settled.kind !== 'ok') {
    amend(key, correctionId, { refusal: failureWords(settled) });
    return;
  }
  const { state, approver, versionId } = settled.value.correction;
  amend(key, correctionId, { state: cardState(state), approver, versionId, refusal: null });
}

export function useCorrections(client: OperationsClient, propose: ProposePort): Corrections {
  const { held, change, amend } = useHeld();
  const business = client.businessKey;
  const mine = held.get(business) ?? EMPTY;
  const read = (key: string, id: string): Promise<void> => readInto(client, amend, key, id);
  const request = async (key: string, ask: CorrectionAsk): Promise<void> => {
    const answer = await propose(ask);
    if (!answer.ok) {
      change(key, (desk) => ({ ...desk, refusal: refusalWords(answer.code) }));
      return;
    }
    const { correctionId } = answer;
    const asked: Correction = {
      correctionId,
      ask,
      state: 'requested',
      approver: null,
      versionId: null,
      refusal: null,
    };
    change(key, (desk) => ({ ...desk, refusal: null, list: [...desk.list, asked] }));
    await read(key, correctionId);
  };
  const decide = async (key: string, id: string, decision: 'approve' | 'reject'): Promise<void> => {
    const versionId = mine.list.find((each) => each.correctionId === id)?.versionId;
    if (versionId === null || versionId === undefined) return;
    const settled = settle(
      await client.mutate('live_correction.decide', { correctionId: id, versionId, decision }),
    );
    if (settled.kind === 'ok') await read(key, id);
    else amend(key, id, { refusal: failureWords(settled) });
  };
  const run = (work: Promise<void>): void => {
    change(business, (desk) => ({ ...desk, busy: desk.busy + 1 }));
    void work.finally(() => {
      change(business, (desk) => ({ ...desk, busy: desk.busy - 1 }));
    });
  };
  return {
    list: mine.list,
    refusal: mine.refusal,
    busy: mine.busy > 0,
    request: (ask) => {
      run(request(business, ask));
    },
    decide: (id, decision) => {
      run(decide(business, id, decision));
    },
  };
}
