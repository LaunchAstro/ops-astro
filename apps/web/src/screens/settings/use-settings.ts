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
//  - **A conflict whose reread did not answer holds every Save** until a
//    reread does (#880): without the row, a write would carry no revision
//    and silently replace the value that won.
//  - **The browser's memory of its last confirmed write is the session's, and
//    only for an unavailable read.** A refused `settings.read` drops it and
//    holds until an authorised read answers (`confirmed.ts`), and a write
//    answered for an owner the tab has left (a sign-out, another business or
//    person) keeps nothing: its tag no longer matches (`data/owned.ts`).
//  - **One operation id per intent.** Save pressed again on the same value
//    after an answer that never arrived carries the first attempt's id.
//
// The write goes through `useMoneyCommand`, which classifies the answer and,
// for the four-eyes threshold's money sign-in, holds it for the step-up code
// and sends it once more on the new sign-in (#881); this file keeps only what
// settings does with each kind.

import { useEffect, useRef, useState } from 'react';
import type { CommandOutcome, MutationOptions, OperationsClient } from '../../operations/client.ts';
import { Intents } from '../../data/intents.ts';
import { ownerOf, useDesk, type Tag } from '../../data/owned.ts';
import type { StorageLike } from '../../session/token.ts';
import { useRead } from '../../data/use-read.ts';
import type { Settlement } from '../../records/use-command.ts';
import { useMoneyCommand } from '../../records/use-money-command.ts';
import type {
  CapabilitiesResult,
  SettingsReadResult,
  SettingView,
} from '../../../../../packages/core-wire/src/index.ts';
import { remember, sessionMemory, type Confirmed, type Draft, type Which } from './confirmed.ts';
import type { Conflict, SettingsModel } from './settings-model.ts';
import {
  GRANT,
  KEY,
  SESSION_CAPABILITIES,
  SETTINGS_READ,
  holds,
  rowsInHand,
  settingOf,
} from './reads.ts';

export type { StorageLike } from '../../session/token.ts';
export type { Confirmed, Draft, Which } from './confirmed.ts';
export type { Conflict, SettingsModel } from './settings-model.ts';

const COMMAND = {
  'four-eyes': 'settings.set_four_eyes_threshold',
  'sign-off': 'settings.set_client_sign_off',
  conversation: 'settings.set_conversation_window',
  retention: 'settings.set_retention_window',
} as const;

/** The session's memory as this screen holds it, and which session it is. */
interface Held {
  readonly grantKey: string;
  readonly confirmed: Confirmed;
  readonly denied: boolean;
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
  const command = useMoneyCommand(client);
  const desk = useDesk(ownerOf(client, grantKey));
  const intents = useRef(new Intents()).current;
  const [pressed, setPressed] = useState<Which>('four-eyes');
  const [complaint, setComplaint] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const busy = command.busy ? pressed : null;
  // A stale write is the conflict, drawn with its draft, not a reason line.
  const failure = command.failure?.kind === 'stale' ? null : command.failure;
  // A stale sign-in on a money setting is answered with the step-up prompt,
  // or where the tab cannot step up, with the fix alone: the code means
  // nothing to the person (MP-2-11).
  const stepUp =
    command.stepUp === null &&
    failure?.kind === 'failed' &&
    failure.refusal.code === 'STEP_UP_REQUIRED'
      ? failure.refusal.fixes.join(' ')
      : null;
  const because = complaint ?? stepUp ?? failure?.because ?? null;

  const read = settings.state;
  const caps = capabilities.state;
  // An absent capability read is not a denial. Nobody decided anything, so the
  // screen behaves as it did before the read existed: it offers the controls,
  // asks once, and closes on the server's refusal. Closing on an absence would
  // make the screen unusable against every build that has not landed it yet.
  const mayFor = (which: Which): boolean =>
    caps.outcome === 'unavailable'
      ? true
      : caps.outcome === 'ready' || caps.outcome === 'empty'
        ? holds(caps.value.grants, GRANT[which])
        : false;
  // A conflict's reread still in flight: the row on screen is the one that
  // lost, so a press now would write against a revision nobody has seen.
  const rereading = conflict !== null && read.outcome === 'loading';

  const rowFor = (which: Which): SettingView | null => settingOf(rowsInHand(read), KEY[which]);

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
    tag: Tag,
  ): void => {
    // Answered for an owner the tab or the screen has left: the sign-out or
    // the switch removed what the tab held, and this answer must not put it back.
    if (!desk.owns(tag)) return;
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
    if (command.locked || !mayFor(which)) return;
    if (conflict !== null && read.outcome !== 'ready') {
      setComplaint(
        'Somebody else changed these settings and they could not be read again, so saving now would write over a value you have not seen. Read the settings again first.',
      );
      return;
    }
    const seen = rowFor(which)?.revision;
    setPressed(which);
    setComplaint(null);
    const tag = desk.save();
    // The id is taken as each attempt leaves: a step-up's resend follows an
    // answer, so it is a new attempt; a lost answer keeps the id for this
    // value, and the revision it was first sent at, so a reread in between
    // cannot turn the replay into `OPERATION_ID_REUSED` (WEB.md).
    let sent = '';
    command.run(
      (to) => {
        const { id, sentWith: revision } = intents.attempt(which, value, seen);
        sent = id;
        const options: MutationOptions =
          revision === undefined
            ? { operationId: id }
            : { operationId: id, expectedRevision: revision };
        return to.mutate(COMMAND[which], { value }, options);
      },
      (settlement) => {
        if (settlement.kind !== 'unknown') intents.answered(which, sent);
        settle(which, value, settlement, tag);
      },
    );
  };

  const everyRow = busy !== null || command.closed || rereading;
  return {
    read,
    capabilities: caps,
    answered: read.outcome === 'ready',
    fallback: read.outcome === 'unavailable',
    confirmed,
    closed: command.closed,
    busy,
    disabled: everyRow,
    disabledFor: (which) => everyRow || !mayFor(which),
    because,
    stepUp: command.stepUp,
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
    retry: settings.reload,
    complain: setComplaint,
    reload: settings.reload,
  };
}
