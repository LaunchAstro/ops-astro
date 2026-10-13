// SPDX-License-Identifier: AGPL-3.0-only
//
// What the graduation region (MP-14-10a) keeps above its read, so an outage,
// which takes only the view off the page, gives it back: the chosen client,
// and for each client the open promotion with its ceiling and expiry, and the
// standing approval form with the draft id it files under. The forms draw from
// this store and write to it, each to its own client's slot only, so no form
// ever draws another client's draft, and a settlement that clears a draft
// clears the form on screen. The region is keyed on the grant, so another
// business or person starts it empty.
//
// A draft id names one filing intent (`draftId` on `mandate.file`). It is
// minted when the form first takes input and kept through outages, client
// changes and step-ups, so a retry under any operation is the same filing to
// the server; only that filing's settlement starts a new draft.

import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Settlement } from '../../records/use-command.ts';
import type { MandateFiling } from './graduation-forms.tsx';
import type { Send } from './graduation-send.ts';

/** The open promotion form: its class and what is typed in it. */
export interface Promotion {
  readonly classId: string;
  readonly ceiling: string;
  readonly expiry: string;
}

/** The standing approval form as typed, and the filing intent it files under. */
export interface MandateDraft {
  readonly label: string;
  /** The class picked; '' until one is, which draws as the client's first. */
  readonly scope: string;
  readonly refuses: boolean;
  readonly ceiling: string;
  readonly expiry: string;
  /** Minted on the form's first input; null before it. */
  readonly draftId: string | null;
}

export type MandateEdit = Partial<Omit<MandateDraft, 'draftId'>>;
export type PromotionEdit = Partial<Omit<Promotion, 'classId'>>;

/** One client's forms. */
export interface Slot {
  readonly promoting: Promotion | null;
  readonly mandate: MandateDraft;
}

export interface DraftsState {
  /** The client the scope bar chose; null until the region first draws. */
  readonly chosen: string | null;
  readonly slots: ReadonlyMap<string, Slot>;
}

const BLANK: MandateDraft = {
  label: '',
  scope: '',
  refuses: false,
  ceiling: '',
  expiry: '',
  draftId: null,
};
const EMPTY: Slot = { promoting: null, mandate: BLANK };

/** `clientId`'s forms in `state`, empty where nothing is typed. */
export const slotIn = (state: DraftsState, clientId: string): Slot =>
  state.slots.get(clientId) ?? EMPTY;

/** The region's store, read through `useDrafts`. */
export class GraduationDrafts {
  #state: DraftsState = { chosen: null, slots: new Map() };
  readonly #listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly snapshot = (): DraftsState => this.#state;

  /** `clientId`'s forms as they are now. */
  slotOf(clientId: string): Slot {
    return slotIn(this.#state, clientId);
  }

  /** Chooses `clientId`; a chosen client that left the region (`gone`) loses its slot. */
  choose(clientId: string, gone: string | null): void {
    const slots = new Map(this.#state.slots);
    if (gone !== null) slots.delete(gone);
    this.#set({ chosen: clientId, slots });
  }

  /** The region shows no client: nothing is chosen, and every slot goes. */
  leave(): void {
    if (this.#state.chosen === null && this.#state.slots.size === 0) return;
    this.#set({ chosen: null, slots: new Map() });
  }

  /** Changes the standing approval form, minting its draft id on the first input. */
  editMandate(clientId: string, edit: MandateEdit): void {
    const slot = this.slotOf(clientId);
    const draftId = slot.mandate.draftId ?? crypto.randomUUID();
    this.#put(clientId, { ...slot, mandate: { ...slot.mandate, ...edit, draftId } });
  }

  /** The draft id the form files under, minted if nothing was typed yet. */
  draftIdOf(clientId: string): string {
    const slot = this.slotOf(clientId);
    if (slot.mandate.draftId !== null) return slot.mandate.draftId;
    const draftId = crypto.randomUUID();
    this.#put(clientId, { ...slot, mandate: { ...slot.mandate, draftId } });
    return draftId;
  }

  /**
   * The filing under `draftId` answered: filed, or refused as a filing already
   * made, its draft is spent and the form starts over. Refused because the
   * draft was already filed with other values, the form keeps what is typed
   * under a new draft. Any other refusal keeps it, and so does a newer draft.
   */
  settleFiling(clientId: string, draftId: string, settled: Settlement): void {
    const refusal = settled.kind === 'failed' ? settled.refusal : null;
    const made = refusal?.code === 'TRANSITION_NOT_PERMITTED';
    const changed = refusal?.code === 'FIELD_VALUE_INVALID' && refusal.names.includes('draftId');
    const slot = this.slotOf(clientId);
    if (slot.mandate.draftId !== draftId) return;
    if (settled.kind === 'ok' || made) this.#put(clientId, { ...slot, mandate: BLANK });
    else if (changed) this.#put(clientId, { ...slot, mandate: { ...slot.mandate, draftId: null } });
  }

  /** Opens the promotion form on `classId`, empty, or closes it with null. */
  openPromotion(clientId: string, classId: string | null): void {
    const promoting = classId === null ? null : { classId, ceiling: '', expiry: '' };
    this.#put(clientId, { ...this.slotOf(clientId), promoting });
  }

  editPromotion(clientId: string, edit: PromotionEdit): void {
    const slot = this.slotOf(clientId);
    if (slot.promoting === null) return;
    this.#put(clientId, { ...slot, promoting: { ...slot.promoting, ...edit } });
  }

  /** Closes the promotion form, if it is still open on `classId`. */
  closePromotion(clientId: string, classId: string): void {
    if (this.slotOf(clientId).promoting?.classId === classId) this.openPromotion(clientId, null);
  }

  #put(clientId: string, slot: Slot): void {
    this.#set({ ...this.#state, slots: new Map([...this.#state.slots, [clientId, slot]]) });
  }

  #set(next: DraftsState): void {
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}

/** The store's state, drawn again on every change. */
export function useDrafts(drafts: GraduationDrafts): DraftsState {
  return useSyncExternalStore(drafts.subscribe, drafts.snapshot, drafts.snapshot);
}

/**
 * The client shown, and the one way to change it, `selectClient`,
 * which withdraws a write held for a fresh sign-in, and its refusal (`drop`),
 * and drops the slot of a chosen client that left the region. A chosen client
 * still in the region is kept; until the fallback to the first lands, the
 * first is drawn with its own slot, so nothing typed for the one that left is
 * ever under it.
 */
export function useChosenClient<C extends { readonly id: string }>(
  clients: readonly C[],
  drafts: GraduationDrafts,
  drop: () => void,
): readonly [C | undefined, (id: string) => void] {
  const state = useDrafts(drafts);
  const { chosen } = state;
  const client = clients.find((one) => one.id === chosen) ?? clients[0];
  const here = client?.id === chosen;
  const selectClient = (id: string): void => {
    drop();
    drafts.choose(id, here ? null : chosen);
  };
  useEffect(() => {
    if (client !== undefined && client.id !== chosen) selectClient(client.id);
  });
  return [client, selectClient];
}

/**
 * A read with no client left skips `Shown` and its client change, so the
 * withdrawal happens here: a held write (`drop`) and every draft go with them.
 */
export function useLeftEmpty(drafts: GraduationDrafts, empty: boolean, drop: () => void): void {
  const withdraw = useRef(drop);
  withdraw.current = drop;
  useEffect(() => {
    if (!empty) return;
    withdraw.current();
    drafts.leave();
  }, [drafts, empty]);
}

/** The client's open promotion, as typed; it stays open, as on main, until it settles or is cancelled. */
export function useOpenPromotion(drafts: GraduationDrafts, clientId: string): Promotion | null {
  return slotIn(useDrafts(drafts), clientId).promoting;
}

/**
 * The client's standing approval form: its draft, how it changes, and how it
 * files, under the draft's id, clearing the draft once that filing is spent.
 */
export function useMandateDraft(drafts: GraduationDrafts, clientId: string, send: Send) {
  const draft = slotIn(useDrafts(drafts), clientId).mandate;
  const edit = (change: MandateEdit): void => drafts.editMandate(clientId, change);
  const file = (mandate: MandateFiling, done: () => void): void => {
    const draftId = drafts.draftIdOf(clientId);
    send('mandate.file', { clientId, ...mandate, draftId }, undefined, (settled) => {
      drafts.settleFiling(clientId, draftId, settled);
      if (settled.kind === 'ok') done();
    });
  };
  return { draft, edit, file };
}
