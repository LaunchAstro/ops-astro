// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, useMemo, useRef, useState } from 'react';
import { ownerOf, useDesk } from '../../data/owned.ts';
import { savedSince, savePreference } from '../../data/preference-saves.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { settle, type Failure } from '../../records/use-command.ts';
import { tabOwnerGeneration } from '../../session/token.ts';

const KEY = 'tasks.pinned';
const MAX_PINS = 128;
const isPinId = (id: unknown): id is string =>
  typeof id === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id);

function pinsIn(value: unknown): readonly string[] | null {
  if (typeof value !== 'object' || value === null || !('preferences' in value)) return null;
  const preferences = value.preferences;
  if (typeof preferences !== 'object' || preferences === null || Array.isArray(preferences))
    return null;
  const pins: unknown = KEY in preferences ? preferences[KEY] : [];
  if (!Array.isArray(pins) || pins.length > MAX_PINS || new Set(pins).size !== pins.length)
    return null;
  return Array.from(pins).every((id: unknown) => isPinId(id)) ? pins : null;
}

export type PinFailure = Failure | { readonly kind: 'invalid'; readonly because: string };
type Save =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving'; readonly value: readonly string[] }
  | { readonly kind: 'unknown'; readonly value: readonly string[]; readonly failure: Failure }
  | { readonly kind: 'refused'; readonly failure: Failure };

interface Lifetime {
  active: boolean;
}
interface Pins {
  readonly lifetime: Lifetime;
  readonly known: boolean;
  readonly loading: boolean;
  readonly pinnedIds: readonly string[];
  readonly readFailure: PinFailure | null;
  readonly save: Save;
}
const empty = (lifetime: Lifetime): Pins => ({
  lifetime,
  known: false,
  loading: true,
  pinnedIds: [],
  readFailure: null,
  save: { kind: 'idle' },
});

export interface TaskPins {
  /** A valid preference read has answered for this client/grant owner. */
  readonly known: boolean;
  readonly loading: boolean;
  /** Includes an optimistic change while saving; consult failure/saving before claiming it persisted. */
  readonly pinnedIds: readonly string[];
  readonly saving: boolean;
  readonly canToggle: boolean;
  readonly failure: PinFailure | null;
  readonly recovery: 'read' | 'retry-save' | null;
  /** Takes a canonical task UUID, never a route key. False means no write was sent. */
  readonly toggle: (taskId: string) => boolean;
  readonly reload: () => void;
  /** Replays the exact unknown save value through the existing held operation ID machinery. */
  readonly retry: () => void;
}

// eslint-disable-next-line max-lines-per-function -- one key's owned read, save and recovery lifecycle
export function useTaskPins(client: OperationsClient, grantKey: string): TaskPins {
  const desk = useDesk(ownerOf(client, grantKey));
  const tab = tabOwnerGeneration();
  const lifetime = useMemo<Lifetime>(() => ({ active: true }), [client, grantKey, tab]);
  const [held, setHeld] = useState<Pins>(() => empty(lifetime));
  const state = held.lifetime === lifetime ? held : empty(lifetime);
  const latest = useRef(state);
  latest.current = state;
  const owns = (): boolean => lifetime.active && latest.current.lifetime === lifetime;
  // Update the ref synchronously too: two presses in one turn cannot send two writes.
  const put = (change: Partial<Pins>): void => {
    if (!owns()) return;
    const next = { ...latest.current, ...change };
    latest.current = next;
    setHeld(next);
  };
  const reload = (): void => {
    if (!owns()) return;
    const tag = desk.read();
    put({ loading: true });
    void client.read<unknown>('preference.read', {}).then((answer) => {
      if (!owns() || !desk.draws(tag)) return answer;
      const result = settle(answer);
      if (result.kind !== 'ok') {
        put({ known: false, loading: false, readFailure: result });
        return answer;
      }
      const pins = pinsIn(result.value);
      if (pins === null) {
        put({
          known: false,
          loading: false,
          readFailure: { kind: 'invalid', because: 'Your task pins could not be read.' },
        });
        return answer;
      }
      const save = latest.current.save;
      const newer = savedSince(KEY, tag);
      // A replacement client has no optimistic value to keep from the previous mount.
      // The shared ledger tells us this read is older, not what that value was.
      if (newer && !latest.current.known && save.kind !== 'saving' && save.kind !== 'unknown') {
        put({
          known: false,
          loading: false,
          readFailure: {
            kind: 'invalid',
            because: 'Your pins changed while this read was pending. Read them again.',
          },
        });
        return answer;
      }
      const keep = newer || save.kind === 'saving' || save.kind === 'unknown';
      put({
        known: true,
        loading: false,
        readFailure: null,
        pinnedIds: keep ? latest.current.pinnedIds : pins,
      });
      return answer;
    });
  };
  const send = (value: readonly string[]): void => {
    if (!owns()) return;
    const tag = desk.save();
    put({ pinnedIds: value, readFailure: null, save: { kind: 'saving', value } });
    void savePreference(client, KEY, value, tag).then((answer) => {
      if (!owns() || !desk.owns(tag)) return answer;
      const result = settle(answer);
      if (result.kind === 'ok') put({ save: { kind: 'idle' } });
      else if (result.kind === 'unknown')
        put({ save: { kind: 'unknown', value, failure: result } });
      else {
        put({ save: { kind: 'refused', failure: result } });
        reload();
      }
      return answer;
    });
  };
  useEffect(() => {
    lifetime.active = true;
    reload();
    return () => {
      lifetime.active = false;
      desk.drop();
    };
  }, [client, grantKey, lifetime, desk]);

  const canToggle =
    state.known &&
    !state.loading &&
    (state.save.kind === 'idle' ||
      (state.save.kind === 'refused' && state.save.failure.kind !== 'closed'));
  const toggle = (taskId: string): boolean => {
    const current = latest.current;
    if (
      !owns() ||
      !current.known ||
      current.loading ||
      current.save.kind === 'saving' ||
      current.save.kind === 'unknown' ||
      (current.save.kind === 'refused' && current.save.failure.kind === 'closed')
    )
      return false;
    if (!isPinId(taskId)) {
      put({ readFailure: { kind: 'invalid', because: 'Pin a task by its canonical UUID.' } });
      return false;
    }
    const removing = current.pinnedIds.includes(taskId);
    if (!removing && current.pinnedIds.length >= MAX_PINS) {
      put({
        readFailure: {
          kind: 'invalid',
          because: 'Unpin a task first: you can keep at most 128 pins.',
        },
      });
      return false;
    }
    send(
      removing ? current.pinnedIds.filter((id) => id !== taskId) : [...current.pinnedIds, taskId],
    );
    return true;
  };
  const failure =
    state.save.kind === 'refused' || state.save.kind === 'unknown'
      ? state.save.failure
      : state.readFailure;
  return {
    known: state.known,
    loading: state.loading,
    pinnedIds: state.pinnedIds,
    saving: state.save.kind === 'saving',
    canToggle,
    failure,
    recovery:
      state.save.kind === 'unknown' ? 'retry-save' : !state.known && !state.loading ? 'read' : null,
    toggle,
    reload,
    retry: () => {
      if (owns() && latest.current.save.kind === 'unknown') send(latest.current.save.value);
    },
  };
}
