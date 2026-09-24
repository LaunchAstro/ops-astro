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
//    only for an unavailable read.** A refused `settings.read` is the server
//    declining to tell this reader the value, so nothing is drawn in its place.
//    The memory is tagged with the session that wrote it and removed at
//    sign-out (`session/token.ts`), because the tab outlives the session and
//    the next person to sign in to it is a different reader.

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
import {
  isRecord,
  jsonSlot,
  settingsCacheKey,
  type JsonSlot,
  type StorageLike,
} from '../../session/token.ts';
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

export type { StorageLike } from '../../session/token.ts';

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

/** As stored: the values and the session they belong to. */
interface Stored extends Confirmed {
  readonly session: string;
}

/** A write the server would not take because somebody else wrote first. */
export interface Conflict {
  readonly which: Which;
  readonly draft: Draft;
  /** The server's refusal, verbatim, so the code can be quoted to somebody. */
  readonly because: string;
}

/**
 * Which session a stored value belongs to, without storing the bearer again.
 *
 * The grant key is business and token together; FNV-1a over it tells one
 * session from another in the same tab, which is all the tag is for.
 */
function sessionTag(grantKey: string): string {
  let hash = 0x811c9dc5;
  for (let at = 0; at < grantKey.length; at += 1) {
    hash = Math.imul(hash ^ (grantKey.codePointAt(at) ?? 0), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Any object passes; `readConfirmed` then checks whose session it was. */
function isStored(value: unknown): value is Partial<Stored> {
  return isRecord(value);
}

/** This business's slot. A storage that throws leaves "not known" drawn. */
function confirmedSlot(
  storage: StorageLike | null,
  businessKey: string,
): JsonSlot<Partial<Stored>> {
  return jsonSlot(storage, settingsCacheKey(businessKey), isStored);
}

function readConfirmed(
  storage: StorageLike | null,
  businessKey: string,
  grantKey: string,
): Confirmed {
  const stored = confirmedSlot(storage, businessKey).read();
  if (stored === null) return {};
  // Another session's value, or one stored before values carried a session,
  // is not this reader's to see.
  const { session, ...values } = stored;
  return session === sessionTag(grantKey) ? values : {};
}

function writeConfirmed(
  storage: StorageLike | null,
  businessKey: string,
  grantKey: string,
  next: Confirmed,
): void {
  // A refused write leaves the screen drawing what it has in hand this render.
  const stored: Stored = { ...next, session: sessionTag(grantKey) };
  confirmedSlot(storage, businessKey).write(stored);
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
  // rather than keeping what the previous session had confirmed.
  const [held, setHeld] = useState(() => ({
    grantKey,
    confirmed: readConfirmed(storage, businessKey, grantKey),
  }));
  const confirmed =
    held.grantKey === grantKey ? held.confirmed : readConfirmed(storage, businessKey, grantKey);
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
    setHeld({ grantKey, confirmed: merged });
    writeConfirmed(storage, businessKey, grantKey, merged);
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
    fallback: read.outcome === 'unavailable',
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
