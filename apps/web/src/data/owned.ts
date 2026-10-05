// SPDX-License-Identifier: AGPL-3.0-only
//
// Whose answer this is: the one rule every read and save on a screen follows
// (docs/local/WEB.md, "How a write settles" and "What the five read states
// mean").
//
// **Every request is tagged before it leaves**: its request number, the
// business and the person it was sent for, and the tab's owner generation (a
// sign-out, or a sign-in to another business or as another person, moves it).
// An answer is drawn only while its tag still matches the screen: the same
// business and person now, the same tab owner, and for a read, the screen's
// newest request. Anything else is dropped: never drawn, never merged, never
// kept in storage. A business or person change moves the screen to a new owner
// in the render that sees it, so the previous owner's answers stop matching
// before a single frame can draw them.
//
// **A save outranks every read that left while it was unsettled.** From the
// moment a save leaves until its answer arrives, nobody knows whether a read
// sees it; `savedSince` tells a read's answer which keys such a save touched,
// so its older value does not undo them (preference-saves.ts keeps that ledger
// per client).
//
// **A save is one operation id per intent** (`Intents`, intents.ts). The same value saved
// again after an answer that never arrived is a retry of the same intent and
// carries the same id, so the server replays a stored success instead of
// storing it twice. Any answer, or another value, starts a new intent, and so
// does a move to another owner: the desk holds its owner's intents and drops
// them with the rest of what it held.
//
// `AuthorisedRead` (authorised-read.ts) is the read projection's form of the
// same rule: its generation is the request number, its grant key the owner.

import { useRef } from 'react';
import { tabOwnerGeneration } from '../session/token.ts';
import type { OperationsClient } from '../operations/client.ts';
import { Intents } from './intents.ts';

/** Who a screen answers to now. */
export interface Owner {
  readonly business: string;
  /** The person's sign-in: their grant key, or the client their sign-in was given. */
  readonly person: string;
}

/** What a request carries from the moment it leaves. */
export interface Tag extends Owner {
  /** Unique in the tab and rising: a later request has a larger number. */
  readonly request: number;
  /** The tab owner it left under (`tabOwnerGeneration`). */
  readonly tab: number;
}

let minted = 0;

/** The next request number in this tab. */
export function nextRequest(): number {
  minted += 1;
  return minted;
}

/** The owner a screen holding `client` under `grantKey` answers to. */
export const ownerOf = (client: OperationsClient, grantKey: string): Owner => ({
  business: client.businessKey,
  person: grantKey,
});

const signIns = new WeakMap<OperationsClient, string>();

/**
 * The owner of a screen that holds only a client. The application builds a
 * client per sign-in, so the client object is the sign-in.
 */
export function ownerOfClient(client: OperationsClient): Owner {
  let person = signIns.get(client);
  if (person === undefined) {
    person = `sign-in-${String(nextRequest())}`;
    signIns.set(client, person);
  }
  return { business: client.businessKey, person };
}

const sameOwner = (a: Owner, b: Owner): boolean =>
  a.business === b.business && a.person === b.person;

/** One screen's requests: whom they are for, and which read is the newest. */
export class Desk {
  #owner: Owner;
  #newestRead = 0;
  #intents = new Intents();

  constructor(owner: Owner) {
    this.#owner = owner;
  }

  get owner(): Owner {
    return this.#owner;
  }

  /** The saves in flight for the owner the screen has now, by intent. */
  get intents(): Intents {
    return this.#intents;
  }

  /** Move the screen to `owner`. True when it changed: every earlier tag stops matching. */
  moveTo(owner: Owner): boolean {
    if (sameOwner(owner, this.#owner)) return false;
    this.#owner = owner;
    this.#newestRead = 0;
    this.#intents = new Intents();
    return true;
  }

  /** Tag a read about to leave. It is the newest until the next one. */
  read(): Tag {
    const tag = this.#tag();
    this.#newestRead = tag.request;
    return tag;
  }

  /** Tag a save about to leave. It does not supersede a read in flight. */
  save(): Tag {
    return this.#tag();
  }

  /** The screen no longer wants the reads in flight: none of them draws. */
  drop(): void {
    this.#newestRead = nextRequest();
  }

  /** Whether `tag` was sent for the owner the screen and the tab have now. */
  owns(tag: Tag): boolean {
    return sameOwner(tag, this.#owner) && tag.tab === tabOwnerGeneration();
  }

  /** Whether a read's answer under `tag` may be drawn: still owned, and the newest read. */
  draws(tag: Tag): boolean {
    return this.owns(tag) && tag.request === this.#newestRead;
  }

  #tag(): Tag {
    return { ...this.#owner, request: nextRequest(), tab: tabOwnerGeneration() };
  }
}

/** A screen's desk, moved to `owner` in the render that sees it change. */
export function useDesk(owner: Owner): Desk {
  const desk = useRef<Desk | null>(null);
  if (desk.current === null) desk.current = new Desk(owner);
  else desk.current.moveTo(owner);
  return desk.current;
}
