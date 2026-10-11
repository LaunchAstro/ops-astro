// SPDX-License-Identifier: AGPL-3.0-only
//
// The person's own preferences (MP-2-11), with no markup in it: Settings
// General ▸ You (`settings/you.tsx`), the board's column widths and the
// to-do list's sort draw and save them through it.

import { useEffect, useRef, useState } from 'react';
import { ownerOf, useDesk, type Desk, type Tag } from './owned.ts';
import { savedSince, savePreference } from './preference-saves.ts';
import { isRefusal, type OperationsClient } from '../operations/client.ts';
import { describeFailure, describeRefusal } from '../records/submit.ts';

export type Preferences = Readonly<Record<string, unknown>>;
type Newer = (key: string) => boolean;

type Held = { readonly of: string; readonly value: Preferences } | null;

/** A read's answer for `of`, but a key saved since the read left keeps its saved value. */
function answered(before: Held, of: string, read: Preferences, newer: Newer) {
  const own = before?.of === of ? before.value : {};
  const kept = Object.entries(own).filter(([key]) => newer(key));
  return { of, value: { ...read, ...Object.fromEntries(kept) } };
}

/** A refused save waiting on a reread to put its stored value back. */
interface Restore {
  readonly of: Tag;
  readonly preference: string;
  readonly back: (stored: unknown) => void;
}

/** Put back each refused save its owner still holds, unless a later save moved that key on. */
function restore(waiting: readonly Restore[], read: Preferences, desk: Desk, newer: Newer): void {
  for (const one of waiting) {
    if (desk.owns(one.of) && !newer(one.preference)) one.back(read[one.preference]);
  }
}

/**
 * A change drawn at once, onto `of`'s own preferences only: another owner's,
 * still held while this one's read is pending, are not carried over.
 */
function changed(before: Held, of: string, key: string, value: unknown): Held {
  const own = before?.of === of ? before.value : {};
  return { of, value: { ...own, [key]: value } };
}

/**
 * The person's own preferences: read once per owner, changed at once, then
 * saved. Every read and save is tagged (`data/owned.ts`): a read draws only
 * while it is the newest for this business and person, and a save's refusal
 * is told, and reread, only for the owner who made it (#464).
 */
export function usePreferences(client: OperationsClient, grantKey: string) {
  const [held, setHeld] = useState<Held>(null);
  // A refusal is said to one owner, as `held` is held for one.
  const [said, setSaid] = useState<{ readonly of: string; readonly text: string } | null>(null);
  const desk = useDesk(ownerOf(client, grantKey));
  // Any reread that draws runs every refused save's restore: a newer reread
  // that superseded the one a refusal asked for does not lose it.
  const restores = useRef<Restore[]>([]);
  const reread = () => {
    const tag = desk.read();
    void client.read<{ readonly preferences?: unknown }>('preference.read', {}).then((answer) => {
      if (!desk.draws(tag)) return answer;
      const preferences = 'value' in answer ? answer.value.preferences : undefined;
      // A key a save touched while this read could not see it keeps the saved value (#540, #541).
      const newer = (key: string): boolean => savedSince(key, tag);
      if (typeof preferences === 'object' && preferences !== null) {
        setHeld((before) => answered(before, grantKey, preferences as Preferences, newer));
        restore(restores.current.splice(0), preferences as Preferences, desk, newer);
      } else if (isRefusal(answer)) setSaid({ of: grantKey, text: describeRefusal(answer) });
      else setSaid({ of: grantKey, text: 'Your preferences could not be read.' });
      return answer;
    });
  };

  useEffect(() => {
    reread();
    return () => {
      desk.drop();
    };
  }, [client, grantKey]);
  const save = (preference: string, value: unknown, back?: (stored: unknown) => void): void => {
    const tag = desk.save();
    setHeld((before) => changed(before, grantKey, preference, value));
    setSaid(null);
    void savePreference(client, preference, value, tag).then((result) => {
      const failed = describeFailure(result);
      if (failed !== null && desk.owns(tag)) {
        setSaid({ of: grantKey, text: failed });
        if (back !== undefined) restores.current.push({ of: tag, preference, back });
        reread();
      }
      return result;
    });
  };

  const preferences = held !== null && held.of === grantKey ? held.value : null;
  const because = said !== null && said.of === grantKey ? said.text : null;
  return { preferences, because, save };
}
