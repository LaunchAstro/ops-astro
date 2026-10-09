// SPDX-License-Identifier: AGPL-3.0-only
//
// What this browser remembers of `/settings`: the last write the server
// confirmed to this session, and whether the server has since refused this
// session the read.
//
// The memory is a fallback for an unavailable read and nothing more. It is
// tagged with the session that wrote it, because the tab outlives the session,
// and sign-out removes it (`session/token.ts`). A refused read replaces it
// with a mark that stands until an authorised read answers: reads use current
// authority, so an outage after the refusal must not draw the old copy back,
// and neither may a copy written before the next authorised read.

import {
  isRecord,
  jsonSlot,
  settingsCacheKey,
  type JsonSlot,
  type StorageLike,
} from '../../session/token.ts';

// `Which`, `Draft` and `remember` moved here whole from use-settings.ts to keep that file
// under the line limit; use-settings.ts re-exports the two types.

/** Which setting a press is about: the two money and sign-off rows, and MP-2-11's two windows. */
export type Which = 'four-eyes' | 'sign-off' | 'conversation' | 'retention' | 'priority';

/** What a person can propose. `null` is the band off, and it is a real value. */
export type Draft = number | boolean | null | readonly string[];

const isThreshold = (value: unknown): value is number | null =>
  value === null || typeof value === 'number';

/** The server's echo when it gave one of the right kind, else what was sent. */
export function remember(which: Which, echo: unknown, value: Draft): Confirmed {
  if (which === 'four-eyes') {
    const fourEyes = isThreshold(echo) ? echo : isThreshold(value) ? value : undefined;
    return fourEyes === undefined ? {} : { fourEyes };
  }
  // The windows keep no browser memory: only the server's read is drawn for them.
  if (which !== 'sign-off') return {};
  const signOff = typeof echo === 'boolean' ? echo : typeof value === 'boolean' ? value : undefined;
  return signOff === undefined ? {} : { signOff };
}

/** What the last confirmed write left behind, per business. */
export interface Confirmed {
  readonly fourEyes?: number | null;
  readonly signOff?: boolean;
}

/**
 * As stored: the values and the session they belong to, or for a session
 * refused `settings.read`, no values and the mark that it was.
 */
interface Stored extends Confirmed {
  readonly session: string;
  readonly denied?: true;
}

/** One session's memory in one business's slot. */
export interface SessionMemory {
  /** This session's confirmed values, or none while it is refused. */
  readonly confirmed: () => Confirmed;
  /** The server refused this session the read, and no read has answered since. */
  readonly denied: () => boolean;
  readonly keep: (next: Confirmed) => void;
  /** Drop the values and mark the refusal, so a remount keeps it too. */
  readonly deny: () => void;
  /** An authorised read answered: remove this session's mark, if it has one. */
  readonly lift: () => void;
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

/** The tab's storage is not this code's: a value of any other shape is none. */
function isStored(value: unknown): value is Stored {
  if (!isRecord(value) || typeof value['session'] !== 'string') return false;
  const { fourEyes, signOff, denied } = value;
  return (
    (fourEyes === undefined || fourEyes === null || typeof fourEyes === 'number') &&
    (signOff === undefined || typeof signOff === 'boolean') &&
    (denied === undefined || denied === true)
  );
}

/** A storage that throws or refuses leaves memory as the only copy. */
export function sessionMemory(
  storage: StorageLike | null,
  businessKey: string,
  grantKey: string,
): SessionMemory {
  const slot: JsonSlot<Stored> = jsonSlot(storage, settingsCacheKey(businessKey), isStored);
  const tag = sessionTag(grantKey);
  // Another session's value is not this reader's to see.
  const own = (): Stored | null => {
    const stored = slot.read();
    return stored?.session === tag ? stored : null;
  };
  const denied = (): boolean => own()?.denied === true;
  return {
    confirmed: () => {
      const stored = own();
      if (stored === null || stored.denied === true) return {};
      const { session: _session, denied: _denied, ...values } = stored;
      return values;
    },
    denied,
    keep: (next) => {
      slot.write({ ...next, session: tag });
    },
    deny: () => {
      slot.write({ session: tag, denied: true });
    },
    lift: () => {
      if (denied()) slot.remove();
    },
  };
}

/** The session's memory as this screen holds it, and which session it is. */
export interface Held {
  readonly grantKey: string;
  readonly confirmed: Confirmed;
  readonly denied: boolean;
}
