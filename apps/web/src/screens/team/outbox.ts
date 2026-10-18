// SPDX-License-Identifier: AGPL-3.0-only
//
// The Team screen's unsent chat words (#1339). A send's words become an entry
// before its command leaves, and leave only when the server takes them or the
// person discards them. A refusal keeps them for the person to edit; a send
// with no answer keeps its operation id, so Resend replays the same operation
// and the server posts the message once.
//
// Entries are kept in the tab's storage under the sign-in that wrote them
// (`grantKey`: business, person and session generation), so a reload shows
// them and another sign-in never does: its screen clears them on mounting.
// Only a mounted screen's outbox writes there, so an answer landing after a
// switch of sign-in never overwrites the next one's words. One found mid-send
// after a reload is unanswered: only a Resend under its own id can learn
// whether it landed. The page and the dock share one outbox while either is
// mounted, so neither writes its words over the other's.

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { TeamConversations, Unsent } from '@launchastro/ui';
import {
  isRefusal,
  isUnavailable,
  type CallResult,
  type OperationsClient,
} from '../../operations/client.ts';
import {
  isOperationId,
  isRecord,
  jsonSlot,
  type JsonSlot,
  type StorageLike,
} from '../../session/storage-slot.ts';

/** How the server answered a send: took it, refused it, or gave no answer. */
export type Sent = 'taken' | 'refused' | 'unanswered';

/** An unsent message and which chat command sends it. */
export interface Entry extends Unsent {
  readonly kind: 'direct' | 'group';
}

interface Kept {
  readonly version: 1;
  readonly owner: string;
  readonly entries: readonly Entry[];
}

const KEY = 'ops-astro.chat-unsent';
const STATES: ReadonlySet<unknown> = new Set(['sending', 'refused', 'unanswered']);

const isEntry = (value: unknown): value is Entry =>
  isRecord(value) &&
  isOperationId(value['id']) &&
  typeof value['to'] === 'string' &&
  typeof value['body'] === 'string' &&
  STATES.has(value['state']) &&
  (value['kind'] === 'direct' || value['kind'] === 'group');

const withState = (entry: Entry, state: Entry['state']): Entry => ({ ...entry, state });

const isKept = (value: unknown): value is Kept =>
  isRecord(value) &&
  value['version'] === 1 &&
  typeof value['owner'] === 'string' &&
  Array.isArray(value['entries']) &&
  value['entries'].every(isEntry);

/** The mounted outboxes, by the tab's storage and then the sign-in. */
const shared = new WeakMap<StorageLike, Map<string, ChatOutbox>>();

function sharedIn(storage: StorageLike): Map<string, ChatOutbox> {
  const byOwner = shared.get(storage) ?? new Map<string, ChatOutbox>();
  shared.set(storage, byOwner);
  return byOwner;
}

export class ChatOutbox {
  /** The outbox every screen of this sign-in in this tab shares while one is mounted. */
  static for(owner: string, storage: StorageLike | null): ChatOutbox {
    if (storage === null) return new ChatOutbox(owner, null);
    const byOwner = sharedIn(storage);
    const outbox = byOwner.get(owner) ?? new ChatOutbox(owner, storage);
    byOwner.set(owner, outbox);
    return outbox;
  }

  readonly #owner: string;
  readonly #storage: StorageLike | null;
  readonly #slot: JsonSlot<Kept>;
  readonly #listeners = new Set<() => void>();
  #entries: readonly Entry[];
  #mounted = 0;

  constructor(owner: string, storage: StorageLike | null) {
    this.#owner = owner;
    this.#storage = storage;
    this.#slot = jsonSlot(storage, KEY, isKept);
    const kept = this.#slot.read();
    this.#entries =
      kept?.owner === owner
        ? kept.entries.map((one) => (one.state === 'sending' ? withState(one, 'unanswered') : one))
        : [];
  }

  snapshot = (): readonly Entry[] => this.#entries;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /**
   * The screen holding this outbox mounted, and the tab's storage now this
   * sign-in's: another sign-in's kept words are cleared. The returned call unmounts it.
   */
  mount = (): (() => void) => {
    this.#mounted += 1;
    const byOwner = this.#storage === null ? undefined : sharedIn(this.#storage);
    if (byOwner !== undefined && !byOwner.has(this.#owner)) byOwner.set(this.#owner, this);
    this.#set(this.#entries);
    return () => {
      this.#mounted -= 1;
      // The last screen gone: the next one reads the tab's storage afresh.
      if (this.#mounted === 0 && byOwner?.get(this.#owner) === this) byOwner.delete(this.#owner);
    };
  };

  entry(id: string): Entry | undefined {
    return this.#entries.find((one) => one.id === id);
  }

  /** A new send's words, or a resend's, kept before its command leaves. */
  sending(entry: Entry): void {
    const others = this.#entries.filter((one) => one.id !== entry.id);
    this.#set([...others, withState(entry, 'sending')]);
  }

  /** The server's answer: taken lets the words go; anything else keeps them. */
  answered(id: string, sent: Sent): void {
    if (sent === 'taken') this.discard(id);
    else this.#set(this.#entries.map((one) => (one.id === id ? withState(one, sent) : one)));
  }

  discard(id: string): void {
    this.#set(this.#entries.filter((one) => one.id !== id));
  }

  #set(entries: readonly Entry[]): void {
    this.#entries = entries;
    // Once unmounted, the tab's storage is the next sign-in's screen's, or nobody's.
    if (this.#mounted > 0 && entries.length === 0) this.#slot.remove();
    else if (this.#mounted > 0) this.#slot.write({ version: 1, owner: this.#owner, entries });
    for (const listener of this.#listeners) listener();
  }
}

/** This sign-in's outbox and its entries; a change of `grantKey` starts from that sign-in's own. */
function useOutbox(
  grantKey: string,
  storage: StorageLike | null,
): readonly [ChatOutbox, readonly Entry[]] {
  const [held, setHeld] = useState(() => ChatOutbox.for(grantKey, storage));
  const [owner, setOwner] = useState(grantKey);
  let outbox = held;
  if (owner !== grantKey) {
    outbox = ChatOutbox.for(grantKey, storage);
    setOwner(grantKey);
    setHeld(outbox);
  }
  useEffect(() => outbox.mount(), [outbox]);
  const entries = useSyncExternalStore(outbox.subscribe, outbox.snapshot);
  return [outbox, entries];
}

/** How a send's answer reads for the outbox. */
const sentOf = (result: CallResult<unknown>): Sent =>
  isUnavailable(result) ? 'unanswered' : isRefusal(result) ? 'refused' : 'taken';

/** The conversations before the outbox takes their sends. */
export type Talk = Omit<TeamConversations, 'unsent' | 'onResend' | 'onDiscard'>;

/** A chat command sent under the operation id given. */
type Run = (
  name: 'chat.send_direct' | 'chat.send_group',
  body: Readonly<Record<string, unknown>>,
  options: { readonly operationId: string },
) => Promise<CallResult<unknown>>;

/** A send kept in the outbox before it leaves, under its own operation id, and let go once taken. */
function sendThrough(outbox: ChatOutbox, run: Run, entry: Entry): void {
  outbox.sending(entry);
  const options = { operationId: entry.id };
  const sent =
    entry.kind === 'direct'
      ? run('chat.send_direct', { teammateId: entry.to, body: entry.body }, options)
      : run('chat.send_group', { conversationId: entry.to, body: entry.body }, options);
  void sent.then((answer) => {
    outbox.answered(entry.id, sentOf(answer));
    return answer;
  });
}

/** The conversations with every send going through this sign-in's outbox. */
export function useOutboxed(
  client: OperationsClient,
  grantKey: string,
  storage: StorageLike | null,
  run: Run,
): (talk: Talk | null) => TeamConversations | null {
  const [outbox, unsent] = useOutbox(grantKey, storage);
  const send = (kind: Entry['kind'], to: string, body: string): void => {
    sendThrough(outbox, run, { id: client.newOperationId(), kind, to, body, state: 'sending' });
  };
  return (talk) =>
    talk === null
      ? null
      : {
          ...talk,
          onSend: (person, body) => {
            send('direct', person, body);
          },
          onGroup: (action) => {
            if (action.do === 'send') send('group', action.id, action.body);
            else talk.onGroup(action);
          },
          unsent,
          onResend: (id) => {
            const entry = outbox.entry(id);
            if (entry?.state === 'unanswered') sendThrough(outbox, run, entry);
          },
          onDiscard: (id) => {
            outbox.discard(id);
          },
        };
}
