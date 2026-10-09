// SPDX-License-Identifier: AGPL-3.0-only
// Settings remains one Desk owner: answers and retained drafts are fenced by owner/tab.
// Priority uncertainty freezes the original array/revision/op through edits and rereads;
// present-authority refusal can withhold stored success, so it closes authority only.
// Legacy scalar memory is session-owned fallback only; money step-up stays unchanged.
// See docs/local/WEB.md for read admission, explicit stale overwrite and write custody.

import { useEffect, useRef, useState } from 'react';
import type { CommandOutcome, OperationsClient } from '../../operations/client.ts';
import { LEFT_BEHIND, ownerOf, useDesk, type Tag } from '../../data/owned.ts';
import { tabOwnerGeneration, type StorageLike } from '../../session/token.ts';
import { priorityStageIds } from '../../../../../packages/core-wire/src/index.ts';
import * as rules from './priority-support.ts';
import { useRead } from '../../data/use-read.ts';
import type { Settlement } from '../../records/use-command.ts';
import { useMoneyCommand } from '../../records/use-money-command.ts';
import type {
  CapabilitiesResult,
  SettingsReadResult,
  SettingView,
} from '../../../../../packages/core-wire/src/index.ts';
import { remember, sessionMemory, type Draft, type Which, type Held } from './confirmed.ts';
import type { Conflict, SettingsModel } from './settings-model.ts';
import { KEY, SESSION_CAPABILITIES, SETTINGS_READ, rowsInHand, settingOf } from './reads.ts';

export type { StorageLike } from '../../session/token.ts';
export type { Confirmed, Draft, Which } from './confirmed.ts';
export type { Conflict, SettingsModel } from './settings-model.ts';

const COMMAND = {
  'four-eyes': 'settings.set_four_eyes_threshold',
  'sign-off': 'settings.set_client_sign_off',
  conversation: 'settings.set_conversation_window',
  retention: 'settings.set_retention_window',
  priority: 'settings.set_priority_stages',
} as const;

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

  // Memory is grant-owned; a refused read holds even when storage cannot write.
  const memory = sessionMemory(storage, businessKey, grantKey);
  const fromMemory = (): Held => ({
    grantKey,
    confirmed: memory.confirmed(),
    denied: memory.denied(),
  });
  const [held, setHeld] = useState(fromMemory);
  const inHand = (was: Held): Held => (was.grantKey === grantKey ? was : fromMemory());
  // Judge custody before state updates: unmount or a later render must not
  // delay memory writes or outrun a read-denial effect.
  const latest = useRef<Held | null>(null);
  const current = (): Held => inHand(latest.current ?? fromMemory());
  const { confirmed } = inHand(held);
  const command = useMoneyCommand(client);
  const desk = useDesk(ownerOf(client, grantKey));
  const priorityIntent = useRef<rules.PriorityIntent | null>(null);
  const [, refreshPriority] = useState(0);
  const [priorityClosedBy, setPriorityClosedBy] = useState<Tag | null>(null);
  if (priorityIntent.current !== null && !desk.owns(priorityIntent.current.tag)) {
    desk.intents.answered('priority', priorityIntent.current.operationId);
    priorityIntent.current = null;
  }
  const keepPriority = (next: rules.PriorityIntent | null): void => {
    priorityIntent.current = next;
    refreshPriority((revision) => revision + 1);
  };
  const [pressed, setPressed] = useState<Which>('four-eyes');
  // The command's last write, the refusal that closed the controls, a conflict
  // and what the screen said, each drawn only for the owner it was for: the
  // command and the screen outlive a switch.
  const [ran, setRan] = useState<Tag | null>(null);
  const [closedBy, setClosedBy] = useState<Tag | null>(null);
  const [stale, setConflict] = useState<{ readonly tag: Tag; readonly is: Conflict } | null>(null);
  const ours = ran === null || desk.owns(ran);
  const closed = closedBy !== null && desk.owns(closedBy);
  const conflict = stale !== null && desk.owns(stale.tag) ? stale.is : null;
  const [said, setSaid] = useState<{ readonly tag: Tag; readonly text: string } | null>(null);
  const complaint = said !== null && desk.owns(said.tag) ? said.text : null;
  const setComplaint = (text: string | null): void => {
    setSaid(text === null ? null : { tag: desk.save(), text });
  };
  // One write at a time, whoever it is for; "Saving" only for its own owner.
  const busy = command.busy && ours ? pressed : null;
  // A stale write is the conflict, drawn with its draft, not a reason line.
  const failure = !ours || command.failure?.kind === 'stale' ? null : command.failure;
  const prompt = ours ? command.stepUp : null;
  const because = rules.reason(prompt, failure, complaint);

  const read = settings.state;
  const caps = capabilities.state;
  const mayFor = (which: Which): boolean => rules.mayFor(caps, grantKey, which);
  // A conflict's reread still in flight: the row on screen is the one that
  // lost, so a press now would write against a revision nobody has seen.
  const rereading = conflict !== null && read.outcome === 'loading';

  const rowFor = (which: Which): SettingView | null => settingOf(rowsInHand(read), KEY[which]);
  const priorityRow = rowFor('priority');
  const priorityClosed = priorityClosedBy !== null && desk.owns(priorityClosedBy);
  const priorityEditable = rules.canEdit(
    read,
    priorityRow,
    grantKey,
    mayFor('priority'),
    priorityClosed,
  );

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
    if (settlement.kind === 'closed') setClosedBy(tag);
    if (settlement.kind === 'stale') {
      // Reread, so the conflict shows what the row holds *now* rather than the
      // value this attempt was made against.
      setConflict({ tag, is: { which, draft: value, because: settlement.because } });
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

  const settlePriority = (
    settlement: Settlement<CommandOutcome>,
    sent: rules.PriorityIntent,
  ): void => {
    const pending = priorityIntent.current;
    if (!desk.owns(sent.tag) || pending?.operationId !== sent.operationId) return;
    if (settlement.kind === 'closed') setPriorityClosedBy(sent.tag);
    // Present authority may withhold recorded success. A refusal after uncertainty
    // does not establish that the original effect did not happen.
    if (rules.remainsUnknown(pending, settlement)) {
      keepPriority({ ...pending, phase: 'unknown' });
      return;
    }
    desk.intents.answered('priority', sent.operationId);
    keepPriority(null);
    if (settlement.kind === 'stale') {
      setConflict({
        tag: sent.tag,
        is: { which: 'priority', draft: sent.value, because: settlement.because },
      });
      settings.reload();
    } else if (settlement.kind === 'ok') {
      setConflict(null);
      settings.reload();
    }
  };

  const save = (which: Which, value: Draft): void => {
    if (command.busy || closed || !mayFor(which)) return;
    if (conflict !== null && read.outcome !== 'ready') {
      setComplaint(
        'Somebody else changed these settings and they could not be read again, so saving now would write over a value you have not seen. Read the settings again first.',
      );
      return;
    }
    const seen = rowFor(which)?.revision;
    let priority = which === 'priority' ? priorityIntent.current : null;
    if (which === 'priority') {
      if (!priorityEditable || (priority !== null && priority.phase !== 'unknown')) return;
      if (priority === null) {
        const chosen = priorityStageIds(value);
        const revision = rules.revision(seen);
        if (chosen === undefined || revision === null) return;
        const intent = desk.intents.attempt('priority', chosen, revision);
        priority = rules.envelope(desk.save(), chosen, intent.sentWith, intent.id);
      } else priority = Object.freeze({ ...priority, phase: 'retrying' });
      keepPriority(priority);
    }
    const envelope = priority;
    setPressed(which);
    setComplaint(null);
    const tag = envelope?.tag ?? desk.save();
    const { intents } = desk;
    setRan(tag);
    // Step-up resends after an answer mint a new intent; lost answers retain
    // the original id and revision through rereads (WEB.md).
    let sent = envelope?.operationId ?? '';
    command.run(
      (to) => {
        // A resend after the screen moved to another owner is not theirs to send.
        if (!desk.owns(tag)) return Promise.resolve(LEFT_BEHIND);
        if (envelope !== null) return to.mutate(COMMAND.priority, ...rules.request(envelope));
        const { id, sentWith: revision } = intents.attempt(which, value, seen);
        sent = id;
        return to.mutate(COMMAND[which], { value }, rules.mutationOptions(id, revision));
      },
      (settlement) => {
        if (envelope !== null) {
          settlePriority(settlement, envelope);
          return;
        }
        if (settlement.kind !== 'unknown') intents.answered(which, sent);
        settle(which, value, settlement, tag);
      },
    );
  };

  const everyRow = command.busy || closed || rereading;
  return {
    read,
    capabilities: caps,
    answered: read.outcome === 'ready',
    fallback: read.outcome === 'unavailable',
    confirmed,
    closed,
    busy,
    disabled: everyRow,
    disabledFor: (which) =>
      everyRow || !mayFor(which) || (which === 'priority' && !priorityEditable),
    priorityOwnerKey: JSON.stringify([businessKey, grantKey, tabOwnerGeneration()]),
    priorityEditable,
    priorityPending: priorityIntent.current !== null,
    priorityUnknown: priorityIntent.current !== null && priorityIntent.current.phase !== 'sending',
    because,
    stepUp: prompt,
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
