// SPDX-License-Identifier: AGPL-3.0-only
//
// Everything `/settings` knows, with no markup in it.
//
// The screen is two reads, two commands and four pieces of state that decide
// what a person may do and what they are told. Keeping that here means the
// screen file is the form and this file is the rules, and the rules are the
// part with teeth:
//
//  - **A write is followed by a reread**, so what lands on the screen is the
//    row as the server holds it rather than the command's echo or the number
//    that was typed.
//  - **`expectedRevision` is feature-detected per row.** A row that came back
//    with a revision is written against it; a row without one is written the
//    way the two commands have always taken it. Sending `expectedRevision:
//    undefined` would be answering a question this server has not asked.
//  - **`VERSION_STALE` is a conflict, not an error.** Somebody else wrote while
//    this person was typing. The screen rereads and holds the draft, and only a
//    second explicit press writes over what the reread found. Retrying against
//    the fresh revision by itself would turn "somebody else got there first"
//    into "you silently overrode them".
//  - **`SCOPE_NOT_GRANTED` on a write closes the controls** whatever the
//    capability read said, because a grant can be revoked between the read and
//    the press and the write is the newer fact.
//  - **The browser's memory of its last confirmed write is the session's, and
//    only for an unavailable read.** A refused `settings.read` drops it and
//    holds until an authorised read answers (`confirmed.ts`), and a write
//    answered after sign-out keeps nothing: the session generation it was
//    pressed in has moved on.
//
// The write itself goes through `useCommand`, which classifies the answer; this
// file keeps only what settings does with each kind.

import { useEffect, useRef, useState } from 'react';
import type { CommandOutcome, MutationOptions, OperationsClient } from '../../operations/client.ts';
import type { ReadState } from '../../data/authorised-read.ts';
import { sessionGeneration, type StorageLike } from '../../session/token.ts';
import { useRead } from '../../data/use-read.ts';
import { useCommand, type Settlement } from '../../records/use-command.ts';
import type {
  CapabilitiesResult,
  SettingRow,
  SettingsReadResult,
} from '../../operations/shapes.ts';
import { sessionMemory, type Confirmed } from './confirmed.ts';
import {
  FOUR_EYES,
  SESSION_CAPABILITIES,
  SETTINGS_READ,
  SIGN_OFF,
  holdsManage,
  rowsInHand,
  settingOf,
} from './reads.ts';

export type { StorageLike } from '../../session/token.ts';
export type { Confirmed } from './confirmed.ts';

/** Which of the two settings a press is about. */
export type Which = 'four-eyes' | 'sign-off';

/** What a person can propose. `null` is the band off, and it is a real value. */
export type Draft = number | boolean | null;

const COMMAND = {
  'four-eyes': 'settings.set_four_eyes_threshold',
  'sign-off': 'settings.set_client_sign_off',
} as const;

const KEY = { 'four-eyes': FOUR_EYES, 'sign-off': SIGN_OFF } as const;

/** A write the server would not take because somebody else wrote first. */
export interface Conflict {
  readonly which: Which;
  readonly draft: Draft;
  /** The server's refusal, verbatim, so the code can be quoted to somebody. */
  readonly because: string;
}

const isThreshold = (value: unknown): value is number | null =>
  value === null || typeof value === 'number';

/** The server's echo when it gave one of the right kind, else what was sent. */
function remember(which: Which, echo: unknown, value: Draft): Confirmed {
  if (which === 'four-eyes') {
    const fourEyes = isThreshold(echo) ? echo : isThreshold(value) ? value : undefined;
    return fourEyes === undefined ? {} : { fourEyes };
  }
  const signOff = typeof echo === 'boolean' ? echo : typeof value === 'boolean' ? value : undefined;
  return signOff === undefined ? {} : { signOff };
}

/** The session's memory as this screen holds it, and which session it is. */
interface Held {
  readonly grantKey: string;
  readonly confirmed: Confirmed;
  readonly denied: boolean;
}

export interface SettingsModel {
  readonly read: ReadState<SettingsReadResult>;
  readonly capabilities: ReadState<CapabilitiesResult>;
  /** The read answered with rows, so the server's values may be drawn. */
  readonly answered: boolean;
  /**
   * Nobody answered, so this session's own confirmed write is all there is.
   * Never true for a refused read: the server declined, and nothing stands in.
   */
  readonly fallback: boolean;
  readonly confirmed: Confirmed;
  readonly closed: boolean;
  readonly busy: Which | null;
  readonly disabled: boolean;
  readonly because: string | null;
  readonly conflict: Conflict | null;
  readonly rowFor: (which: Which) => SettingRow | null;
  readonly save: (which: Which, value: Draft) => void;
  /** The second explicit press: the person choosing to overwrite what they saw. */
  readonly writeOver: () => void;
  /** Something this screen decided, not the server. Never dressed as a refusal. */
  readonly complain: (text: string) => void;
}

export function useSettings(
  client: OperationsClient,
  grantKey: string,
  storage: StorageLike | null,
): SettingsModel {
  const businessKey = client.businessKey;

  const settings = useRead<SettingsReadResult>({
    grantKey,
    run: () => client.read<SettingsReadResult>(SETTINGS_READ, {}),
    // An authorised read that carries no rows is empty, not ready and not a
    // failure: the business holds neither setting yet.
    isEmpty: (value) => value.settings.length === 0,
    deps: [],
  });
  const capabilities = useRead<CapabilitiesResult>({
    grantKey,
    run: () => client.read<CapabilitiesResult>(SESSION_CAPABILITIES, {}),
    deps: [],
  });

  // Keyed by the grant: a new session in a still-mounted screen reads afresh
  // rather than keeping what the previous session had confirmed. The refusal's
  // hold is kept in memory as well as in storage, so a storage that refuses
  // writes does not lift it.
  const memory = sessionMemory(storage, businessKey, grantKey);
  const fromMemory = (): Held => ({
    grantKey,
    confirmed: memory.confirmed(),
    denied: memory.denied(),
  });
  const [held, setHeld] = useState(fromMemory);
  const inHand = (was: Held): Held => (was.grantKey === grantKey ? was : fromMemory());
  // The hold as it stands now, beside the one on screen. A save is decided
  // from this and written to storage when it answers, never inside a state
  // updater: React runs an updater on its next render, which an unmounted
  // screen never has, and which can come after the denial's effect has
  // written its mark over the value the save would then write back.
  const latest = useRef<Held | null>(null);
  const current = (): Held => inHand(latest.current ?? fromMemory());
  const { confirmed } = inHand(held);
  const command = useCommand();
  const [pressed, setPressed] = useState<Which>('four-eyes');
  const [complaint, setComplaint] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const busy = command.busy ? pressed : null;
  // A stale write is the conflict, drawn with its draft, not a reason line.
  const failure = command.failure?.kind === 'stale' ? null : command.failure;
  const because = complaint ?? failure?.because ?? null;

  const read = settings.state;
  const caps = capabilities.state;
  // An absent capability read is not a denial. Nobody decided anything, so the
  // screen behaves as it did before the read existed: it offers the controls,
  // asks once, and closes on the server's refusal. Closing on an absence would
  // make the screen unusable against every build that has not landed it yet.
  const mayManage =
    caps.outcome === 'unavailable'
      ? true
      : caps.outcome === 'ready' || caps.outcome === 'empty'
        ? holdsManage(caps.value.grants)
        : false;
  const shut = command.closed || !mayManage;
  // A conflict's reread still in flight: the row on screen is the one that
  // lost, so a press now would write against a revision nobody has seen.
  const rereading = conflict !== null && read.outcome === 'loading';

  const rowFor = (which: Which): SettingRow | null => settingOf(rowsInHand(read), KEY[which]);

  // What the read decided about the memory, once per answer. A refusal drops
  // it and holds; an authorised answer lifts the hold, and the server's rows
  // are then what is drawn.
  const readOutcome = read.grantKey === grantKey ? read.outcome : 'loading';
  useEffect(() => {
    const memoryNow = sessionMemory(storage, businessKey, grantKey);
    const now = latest.current?.grantKey === grantKey ? latest.current : null;
    if (readOutcome === 'denied') {
      memoryNow.deny();
      latest.current = { grantKey, confirmed: {}, denied: true };
      setHeld(latest.current);
    } else if (readOutcome === 'ready' || readOutcome === 'empty') {
      memoryNow.lift();
      if (now?.denied === true) latest.current = { ...now, denied: false };
      setHeld((was) => (was.grantKey === grantKey && was.denied ? { ...was, denied: false } : was));
    }
  }, [readOutcome, storage, businessKey, grantKey]);

  const settle = (
    which: Which,
    value: Draft,
    settlement: Settlement<CommandOutcome>,
    pressedIn: number,
  ): void => {
    // Answered after the session that pressed Save ended: the sign-out has
    // removed what the tab held, and this answer must not put it back.
    if (sessionGeneration() !== pressedIn) return;
    if (settlement.kind === 'stale') {
      // Reread, so the conflict shows what the row holds *now* rather than the
      // value this attempt was made against.
      setConflict({ which, draft: value, because: settlement.because });
      settings.reload();
      return;
    }
    if (settlement.kind !== 'ok') return;
    setConflict(null);
    const kept = remember(which, settlement.value.detail?.['value'], value);
    // A session refused the read keeps nothing until a read answers it. The
    // hold is judged as it stands now, not as it stood when Save was pressed:
    // a refusal that arrived while the write was in flight still holds, even
    // when there is no storage to have recorded it. The value is kept now,
    // whether or not the screen is still mounted; a refusal whose effect has
    // not run yet writes its mark after this and wins. The stored mark is read
    // too: another screen in this session may have been refused since this
    // one's ref was last set, and this screen may be gone.
    const now = current();
    if (!now.denied && !memory.denied()) {
      const next: Held = { grantKey, confirmed: { ...now.confirmed, ...kept }, denied: false };
      latest.current = next;
      memory.keep(next.confirmed);
      setHeld((was) => (inHand(was).denied ? was : next));
    }
    // The row as the server holds it, not the echo and not what was typed.
    settings.reload();
  };

  const save = (which: Which, value: Draft): void => {
    if (command.locked || !mayManage) return;
    const revision = rowFor(which)?.revision;
    const options: MutationOptions = revision === undefined ? {} : { expectedRevision: revision };
    setPressed(which);
    setComplaint(null);
    const pressedIn = sessionGeneration();
    command.run(
      () => client.mutate(COMMAND[which], { value }, options),
      (settlement) => {
        settle(which, value, settlement, pressedIn);
      },
    );
  };

  return {
    read,
    capabilities: caps,
    answered: read.outcome === 'ready',
    fallback: read.outcome === 'unavailable',
    confirmed,
    closed: command.closed,
    busy,
    disabled: busy !== null || shut || rereading,
    because,
    conflict,
    rowFor,
    save,
    writeOver: () => {
      // Only over what the reread showed: never while it is in flight, and
      // never when it did not answer, which would write with no revision at all.
      if (conflict === null || read.outcome !== 'ready') return;
      setConflict(null);
      save(conflict.which, conflict.draft);
    },
    complain: setComplaint,
  };
}
