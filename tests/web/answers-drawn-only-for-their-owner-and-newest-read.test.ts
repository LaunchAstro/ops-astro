// SPDX-License-Identifier: AGPL-3.0-only
//
// The web state layer's one rule (`apps/web/src/data/owned.ts`): every read
// and save carries its request number, business and person, and an answer is
// drawn only while those still match the screen and the tab. The crossing is
// real: Ada and Ben, in Alpha and Bravo, with the tab's own session store
// moving between them while requests are in flight.

import { describe, expect, it } from 'vitest';
import { Intents } from '../../apps/web/src/data/intents.ts';
import { Desk, type Owner } from '../../apps/web/src/data/owned.ts';
import { SessionStore, grantKeyOf, type StorageLike } from '../../apps/web/src/session/token.ts';

const memory = (): StorageLike => {
  const held = new Map<string, string>();
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  };
};

const ADA_ALPHA = { businessKey: 'alpha', email: 'ada@example.test', sessionId: 's-ada' };
const ADA_BRAVO = { businessKey: 'bravo', email: 'ada@example.test', sessionId: 's-ada' };
const BEN_ALPHA = { businessKey: 'alpha', email: 'ben@example.test', sessionId: 's-ben' };

const ownerOfSession = (session: typeof ADA_ALPHA): Owner => ({
  business: session.businessKey,
  person: grantKeyOf(session),
});

describe('an answer is drawn only for its owner and its newest read', () => {
  it('every tag names its request, business and person', () => {
    const desk = new Desk(ownerOfSession(ADA_ALPHA));
    const read = desk.read();
    const save = desk.save();
    expect(read).toMatchObject({ business: 'alpha', person: grantKeyOf(ADA_ALPHA) });
    expect(save.request).toBeGreaterThan(read.request);
  });

  it('an older read is dropped once a newer one leaves; a save does not supersede a read', () => {
    const desk = new Desk(ownerOfSession(ADA_ALPHA));
    const first = desk.read();
    const second = desk.read();
    const save = desk.save();
    expect(desk.draws(first)).toBe(false);
    expect(desk.draws(second)).toBe(true);
    expect(desk.owns(save)).toBe(true);
  });
});

describe('a move to another owner drops the previous owner’s answers', () => {
  it.each([
    ['business to business', ADA_BRAVO],
    ['person to person', BEN_ALPHA],
  ])('a %s move drops every answer tagged for the previous owner', (_boundary, next) => {
    const store = new SessionStore(memory());
    store.set(ADA_ALPHA);
    const desk = new Desk(ownerOfSession(ADA_ALPHA));
    const read = desk.read();
    const save = desk.save();
    store.set(next);
    expect(desk.moveTo(ownerOfSession(next))).toBe(true);
    expect({ read: desk.draws(read), save: desk.owns(save) }).toEqual({ read: false, save: false });
    // The new owner's own read draws.
    expect(desk.draws(desk.read())).toBe(true);
  });

  it.each([
    ['a switch to another business', (store: SessionStore) => store.set(ADA_BRAVO)],
    ['another person signing in', (store: SessionStore) => store.set(BEN_ALPHA)],
    ['a sign-out', (store: SessionStore) => store.clear()],
  ])('%s drops answers even for a screen that never saw it', (_change, change) => {
    const store = new SessionStore(memory());
    store.set(ADA_ALPHA);
    const desk = new Desk(ownerOfSession(ADA_ALPHA));
    const read = desk.read();
    const save = desk.save();
    change(store);
    expect({ read: desk.draws(read), save: desk.owns(save) }).toEqual({ read: false, save: false });
  });

  it('the same person stepping up to a new sign-in keeps the tab owner', () => {
    const store = new SessionStore(memory());
    store.set(ADA_ALPHA);
    const desk = new Desk(ownerOfSession(ADA_ALPHA));
    const save = desk.save();
    store.set({ ...ADA_ALPHA, sessionId: 's-ada-stepped-up' });
    expect(desk.owns(save)).toBe(true);
  });

  it('a dropped desk draws none of the reads in flight', () => {
    const desk = new Desk(ownerOfSession(ADA_ALPHA));
    const read = desk.read();
    desk.drop();
    expect(desk.draws(read)).toBe(false);
  });
});

describe('one operation id per intent', () => {
  it('the same value keeps its id until an answer arrives; another value gets a new one', () => {
    const intents = new Intents();
    const lost = intents.idFor('four-eyes', 1200);
    expect(intents.idFor('four-eyes', 1200)).toBe(lost);
    const changed = intents.idFor('four-eyes', 1300);
    expect(changed).not.toBe(lost);
    intents.answered('four-eyes', changed);
    expect(intents.idFor('four-eyes', 1300)).not.toBe(changed);
  });

  it('an answer to an earlier attempt does not end a later intent', () => {
    const intents = new Intents();
    const first = intents.idFor('appearance', 'dark');
    const second = intents.idFor('appearance', 'light');
    intents.answered('appearance', first);
    expect(intents.idFor('appearance', 'light')).toBe(second);
  });
});
