// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 (P30): the sidebar's two correction desks. One holds the corrections
// waiting on a person's decision; the other holds the rest, decided or
// carried on from a decision. The desks are drawn from the hook's list, which
// is the active business's alone (`use-corrections.ts`).
//
// **The request port.** `requestPort` sends `live_correction.request` through
// the web's command client. Beside the two words the command takes the party,
// the task, the file's path, the page's address, the base revision and the
// whole file as it reads now, none of which the sidebar knows: the host hands
// them in through `Locate`, the site read. Without one no door is drawn.

import type { OperationsClient } from '../operations/client.ts';
import { settle } from '../records/use-command.ts';
import { replaced, type CardState, type CorrectionAsk, type ProposePort } from './correction.ts';

/** One correction as the sidebar holds it: what was asked, and its decision as last read. */
export interface Correction {
  readonly correctionId: string;
  readonly ask: CorrectionAsk;
  readonly state: CardState;
  /** The person who decided it, by name, or null until then. */
  readonly approver: string | null;
  /** The version a decision names; null until the first read answers. */
  readonly versionId: string | null;
  /** The last read's or decision's refusal, in the server's words. */
  readonly refusal: string | null;
}

export interface Desk {
  readonly key: 'waiting' | 'settled';
  readonly title: string;
  readonly corrections: readonly Correction[];
}

/** The two desks, each drawn only when it holds a correction. */
export function desksOf(corrections: readonly Correction[]): readonly Desk[] {
  const waiting = corrections.filter((each) => each.state === 'requested');
  const settled = corrections.filter((each) => each.state !== 'requested');
  const desks: readonly Desk[] = [
    { key: 'waiting', title: 'Waiting for a decision', corrections: waiting },
    { key: 'settled', title: 'Decided', corrections: settled },
  ];
  return desks.filter((desk) => desk.corrections.length > 0);
}

/** Where the word sits on the site: what `live_correction.request` takes beside the words. */
export interface CorrectionTarget {
  readonly partyId: string;
  readonly taskId: string;
  readonly path: string;
  readonly pageUrl: string;
  readonly baseRevision: string;
  /** The whole file as it reads at `baseRevision`. */
  readonly before: string;
}

/** The site read that finds a named page's file, or null where the site has no such page. */
export type Locate = (ask: CorrectionAsk) => Promise<CorrectionTarget | null>;

/** The door's port, bound to `live_correction.request` through the command client. */
export const requestPort =
  (client: OperationsClient, locate: Locate): ProposePort =>
  async (ask) => {
    const target = await locate(ask);
    if (target === null) return { ok: false, code: 'NOT_FOUND' };
    const after = replaced(target.before, ask.word, ask.replacement);
    if (after === null) return { ok: false, code: 'WORD_NOT_FOUND' };
    const { word, replacement } = ask;
    const operands = { ...target, word, replacement, after };
    const settled = settle(await client.mutate('live_correction.request', operands));
    if (settled.kind === 'unknown') return { ok: false, code: 'UNAVAILABLE' };
    if (settled.kind !== 'ok') return { ok: false, code: settled.refusal.code };
    const id = settled.value.detail?.['correctionId'];
    return typeof id === 'string'
      ? { ok: true, correctionId: id }
      : { ok: false, code: 'UNAVAILABLE' };
  };
