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

import { useState } from 'react';
import {
  isRefusal,
  isUnavailable,
  type CallResult,
  type CommandOutcome,
  type MutationOptions,
  type OperationsClient,
} from '../../operations/client.ts';
import type { ReadState } from '../../data/authorised-read.ts';
import { useRead } from '../../data/use-read.ts';
import { describeFailure, describeRefusal } from '../../records/submit.ts';
import type {
  CapabilitiesResult,
  SettingRow,
  SettingsReadResult,
} from '../../operations/shapes.ts';
import {
  FOUR_EYES,
  SESSION_CAPABILITIES,
  SETTINGS_READ,
  SIGN_OFF,
  holdsManage,
  settingOf,
} from './reads.ts';

/** The narrow part of `Storage` this screen uses, so a test can hand it one. */
export interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/** Which of the two settings a press is about. */
export type Which = 'four-eyes' | 'sign-off';

/** What a person can propose. `null` is the band off, and it is a real value. */
export type Draft = number | boolean | null;

const COMMAND = {
  'four-eyes': 'settings.set_four_eyes_threshold',
  'sign-off': 'settings.set_client_sign_off',
} as const;

const KEY = { 'four-eyes': FOUR_EYES, 'sign-off': SIGN_OFF } as const;

/** What the last confirmed write left behind, per business. The fallback only. */
export interface Confirmed {
  readonly fourEyes?: number | null;
  readonly signOff?: boolean;
}

/** A write the server would not take because somebody else wrote first. */
export interface Conflict {
  readonly which: Which;
  readonly draft: Draft;
  /** The server's refusal, verbatim, so the code can be quoted to somebody. */
  readonly because: string;
}

const keyFor = (businessKey: string): string => `ops-astro.settings.${businessKey}`;

function readConfirmed(storage: StorageLike | null, businessKey: string): Confirmed {
  // A storage that throws — private mode, blocked site data — must leave the
  // screen drawing "not known", which is the truth in that tab anyway.
  try {
    const raw = storage?.getItem(keyFor(businessKey)) ?? null;
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Confirmed) : {};
  } catch {
    return {};
  }
}

function writeConfirmed(storage: StorageLike | null, businessKey: string, next: Confirmed): void {
  try {
    storage?.setItem(keyFor(businessKey), JSON.stringify(next));
  } catch {
    /* Nothing to do. The screen still draws what it has in hand this render. */
  }
}

/** The server's own echo of the row it wrote, or nothing when it said nothing. */
function echoed(result: CallResult<CommandOutcome>): unknown {
  if (!('ok' in result)) return undefined;
  return result.value.detail?.['value'];
}

function remember(which: Which, echo: unknown, value: Draft): Confirmed {
  if (which === 'four-eyes') {
    const number =
      echo === null ? null : typeof echo === 'number' ? echo : (value as number | null);
    return { fourEyes: number };
  }
  return { signOff: typeof echo === 'boolean' ? echo : (value as boolean) };
}

export interface SettingsModel {
  readonly read: ReadState<SettingsReadResult>;
  readonly capabilities: ReadState<CapabilitiesResult>;
  /** The read answered with rows, so the server's values may be drawn. */
  readonly answered: boolean;
  /** Nobody answered, so this browser's own confirmed write is all there is. */
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

  const [confirmed, setConfirmed] = useState<Confirmed>(() => readConfirmed(storage, businessKey));
  const [because, setBecause] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [closed, setClosed] = useState(false);
  const [busy, setBusy] = useState<Which | null>(null);

  const read = settings.state;
  const caps = capabilities.state;
  const grants = caps.value?.grants ?? [];
  // An absent capability read is not a denial. Nobody decided anything, so the
  // screen behaves as it did before the read existed: it offers the controls,
  // asks once, and closes on the server's refusal. Closing on an absence would
  // make the screen unusable against every build that has not landed it yet.
  const mayManage =
    caps.outcome === 'unavailable'
      ? true
      : caps.outcome === 'ready' || caps.outcome === 'empty'
        ? holdsManage(grants)
        : false;
  const shut = closed || !mayManage;

  const rowFor = (which: Which): SettingRow | null => settingOf(read.value, KEY[which]);

  const settle = (which: Which, value: Draft, result: CallResult<CommandOutcome>): void => {
    setBusy(null);
    if (isRefusal(result)) {
      if (result.code === 'VERSION_STALE') {
        // Reread, so the conflict shows what the row holds *now* rather than
        // the value this attempt was made against.
        setConflict({ which, draft: value, because: describeRefusal(result) });
        settings.reload();
        return;
      }
      if (result.code === 'SCOPE_NOT_GRANTED') setClosed(true);
      setBecause(describeRefusal(result));
      return;
    }
    if (isUnavailable(result)) {
      setBecause(describeFailure(result));
      return;
    }
    setBecause(null);
    setConflict(null);
    const merged = { ...confirmed, ...remember(which, echoed(result), value) };
    setConfirmed(merged);
    writeConfirmed(storage, businessKey, merged);
    // The row as the server holds it, not the echo and not what was typed.
    settings.reload();
  };

  const save = (which: Which, value: Draft): void => {
    if (busy !== null || shut) return;
    const revision = rowFor(which)?.revision;
    const options: MutationOptions = revision === undefined ? {} : { expectedRevision: revision };
    setBusy(which);
    setBecause(null);
    void (async () => {
      settle(which, value, await client.mutate(COMMAND[which], { value }, options));
    })();
  };

  return {
    read,
    capabilities: caps,
    answered: read.outcome === 'ready',
    fallback: read.outcome === 'denied' || read.outcome === 'unavailable',
    confirmed,
    closed,
    busy,
    disabled: busy !== null || shut,
    because,
    conflict,
    rowFor,
    save,
    writeOver: () => {
      if (conflict === null) return;
      setConflict(null);
      save(conflict.which, conflict.draft);
    },
    complain: setBecause,
  };
}
