// SPDX-License-Identifier: AGPL-3.0-only
//
// C80: the two desks a sidebar correction request can go to.
//
// **The live desk** sends `live_correction.request` with the target its
// `locate` port finds (party, task, file, page address, base revision and the
// line the word sits in) and draws the state the server answered. While the
// card waits it offers "Check again", which reads the decision back through
// `live_correction.read` (the state, the deciding approver by name and the
// version, nothing more) and redraws the card it already holds in place.
//
// **The made-up desk** is what the drawer uses until the site read that
// locates a word on a catalogued page (the capture catalogue, C35's placement)
// joins: the decision read has, the locate read has not. It answers from one
// made-up About page and a made-up approver, sends nothing, and its
// `provenance` is `mock`, so every line it draws wears the kit's mock mark.

import type { AssistantCorrection, AssistantCorrectionState } from '@launchastro/ui';
import type { LiveCorrectionReadResult } from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../operations/client.ts';
import { settle } from '../records/use-command.ts';
import {
  corrected,
  type CorrectionAsk,
  type CorrectionDesk,
  type CorrectionTarget,
  type DeskAnswer,
} from './correction.ts';

export type Locate = (ask: CorrectionAsk) => Promise<CorrectionTarget | null>;

const refused = (because: string): DeskAnswer => ({ kind: 'refused', because });

const notThere = (ask: CorrectionAsk): DeskAnswer =>
  refused(`“${ask.word}” is not in the line this asks about on the ${ask.page} page.`);

/** The record's state as the card says it; the approval holds through publish and revert. */
function stateOf(state: unknown): AssistantCorrectionState | null {
  if (state === 'requested') return 'waiting';
  if (state === 'rejected') return 'refused';
  const decided = ['approved', 'accepted', 'live', 'unknown', 'failed', 'reverted'];
  return typeof state === 'string' && decided.includes(state) ? 'approved' : null;
}

export function liveDesk(client: OperationsClient, locate: Locate): CorrectionDesk {
  const asked = new Map<string, AssistantCorrection>();
  return {
    provenance: 'real',
    request: async (ask) => {
      const target = await locate(ask);
      if (target === null) return refused(`The ${ask.page} page is not one this site can change.`);
      const after = corrected(target.before, ask.word, ask.replacement);
      if (after === null) return notThere(ask);
      const settled = settle(
        await client.mutate('live_correction.request', {
          ...target,
          word: ask.word,
          replacement: ask.replacement,
          after,
        }),
      );
      if (settled.kind !== 'ok') return refused(settled.because);
      const id = settled.value.detail?.['correctionId'];
      const state = stateOf(settled.value.detail?.['state']);
      if (typeof id !== 'string' || state === null) return refused('No correction came back.');
      const checkable = state === 'waiting';
      const correction = { ...ask, before: target.before, after, state, approver: null, checkable };
      asked.set(id, correction);
      return { kind: 'card', correctionId: id, correction };
    },
    // The card this desk drew, with the decision as the server reads it now.
    recheck: async (correctionId) => {
      const known = asked.get(correctionId);
      if (known === undefined) return refused('No such request was made here.');
      const settled = settle(
        await client.read<LiveCorrectionReadResult>('live_correction.read', { correctionId }),
      );
      if (settled.kind !== 'ok') return refused(settled.because);
      const read = settled.value.correction;
      const state = stateOf(read.state);
      if (state === null) return refused('No decision came back.');
      const correction = {
        ...known,
        state,
        approver: read.approver,
        checkable: state === 'waiting',
      };
      asked.set(correctionId, correction);
      return { kind: 'card', correctionId, correction };
    },
  };
}

/** Made up: the agency's About page's opening line, as the site read would find it. */
const MADE_UP_LINE = 'We work alongside the teams who run your website, from the first brief.';

export function madeUpDesk(): CorrectionDesk {
  const asked = new Map<string, AssistantCorrection>();
  return {
    provenance: 'mock',
    request: (ask) => {
      if (ask.page !== 'About') {
        return Promise.resolve(refused('Only an About page is made up here.'));
      }
      const after = corrected(MADE_UP_LINE, ask.word, ask.replacement);
      if (after === null) return Promise.resolve(notThere(ask));
      const correctionId = `made-up-${String(asked.size + 1)}`;
      const correction: AssistantCorrection = {
        ...ask,
        before: MADE_UP_LINE,
        after,
        state: 'waiting',
        approver: null,
        checkable: true,
      };
      asked.set(correctionId, correction);
      return Promise.resolve({ kind: 'card', correctionId, correction });
    },
    // The made-up approver approves on the first look.
    recheck: (correctionId) => {
      const known = asked.get(correctionId);
      if (known === undefined) return Promise.resolve(refused('No such made-up request.'));
      const correction = { ...known, state: 'approved' as const, checkable: false };
      asked.set(correctionId, correction);
      return Promise.resolve({ kind: 'card', correctionId, correction });
    },
  };
}
