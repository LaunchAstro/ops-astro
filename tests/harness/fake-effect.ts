// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12, part one: FP-E, the fake effect provider every harness entry shares
// (TEST.md 4.2). The external system the governed effect lands in: a fake
// site-copy service holding one throwaway page (U3's controlled copy
// correction), with a write, a read-back and a request log.
//
// An operation declares one of the three reconcile modes the execution-owner
// contract names: `naturally_idempotent` (a client token; the same token
// twice lands once), `reconcilable` (a reference held before dispatch, which
// the service can be asked about), and `neither`. The fixture drives the
// service into each of the five states the reconciliation rule reads, so all
// five are reachable on demand. Every write keeps the page's history, so the
// effect is reversible by writing an earlier revision back.

export type ReconcileMode = 'naturally_idempotent' | 'reconcilable' | 'neither';

/** The five states the reconciliation rule distinguishes (case F12's input alphabet). */
export type EffectState =
  'accepted_says_so' | 'not_accepted_says_so' | 'accepted_cannot_say' | 'unreadable' | 'ambiguous';

export interface EffectWrite {
  readonly mode: ReconcileMode;
  /** The client token (`naturally_idempotent`) or the reference held before dispatch (`reconcilable`). */
  readonly key: string | null;
  readonly body: string;
}

export type WriteAnswer =
  | { readonly kind: 'accepted'; readonly revision: number }
  | { readonly kind: 'not_accepted' }
  | { readonly kind: 'no_answer' }
  | { readonly kind: 'ambiguous' };

export type Reconciled =
  'accepted' | 'not_accepted' | 'cannot_say' | 'unreadable' | 'ambiguous' | 'not_reconcilable';

export interface PageCopy {
  readonly id: string;
  readonly revision: number;
  readonly body: string;
}

export interface EffectService {
  write(request: EffectWrite): WriteAnswer;
  reconcile(mode: ReconcileMode, key: string): Reconciled;
  read(): PageCopy | 'unreadable';
}

export interface EffectFixture {
  drive(next: EffectState): void;
  readonly log: readonly EffectWrite[];
  readonly history: readonly PageCopy[];
}

const RECONCILED: Readonly<Record<EffectState, Reconciled>> = {
  accepted_says_so: 'accepted',
  not_accepted_says_so: 'not_accepted',
  accepted_cannot_say: 'cannot_say',
  unreadable: 'unreadable',
  ambiguous: 'ambiguous',
};

function answerOf(state: EffectState, revision: number): WriteAnswer {
  if (state === 'accepted_says_so') return { kind: 'accepted', revision };
  if (state === 'not_accepted_says_so') return { kind: 'not_accepted' };
  if (state === 'ambiguous') return { kind: 'ambiguous' };
  return { kind: 'no_answer' };
}

export function fakeEffect(original = 'The original throwaway page copy.'): {
  readonly service: EffectService;
  readonly fixture: EffectFixture;
} {
  let state: EffectState = 'accepted_says_so';
  const history: PageCopy[] = [{ id: 'throwaway-page', revision: 1, body: original }];
  const log: EffectWrite[] = [];
  const landed = new Map<string, EffectState>();
  const current = (): PageCopy => history.at(-1) as PageCopy;
  const service: EffectService = {
    write: (request) => {
      log.push(request);
      const replayed = request.mode === 'naturally_idempotent' && request.key !== null;
      if (replayed && landed.get(request.key as string) !== undefined) {
        return answerOf(state, current().revision);
      }
      if (state !== 'not_accepted_says_so') {
        history.push({ ...current(), revision: current().revision + 1, body: request.body });
      }
      if (request.key !== null && request.mode !== 'neither') landed.set(request.key, state);
      return answerOf(state, current().revision);
    },
    reconcile: (mode, key) => {
      if (mode === 'neither') return 'not_reconcilable';
      const at = landed.get(key);
      return at === undefined ? 'not_accepted' : RECONCILED[at];
    },
    read: () => (state === 'unreadable' ? 'unreadable' : current()),
  };
  return {
    service,
    fixture: {
      drive: (next) => {
        state = next;
      },
      log,
      history,
    },
  };
}
