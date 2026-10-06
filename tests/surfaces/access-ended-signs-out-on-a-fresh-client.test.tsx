// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C58: a person whose access was ended is signed out by the first answer that
// says so, whichever client hears it. A reload builds a new client with no
// memory of earlier answers, so the decision is the server's explicit code,
// 403 `AUTH_ACCESS_ENDED`, matched exactly. A 403 `AUTH_NO_MEMBERSHIP` is a
// denial to draw, before or after any success, and keeps the session.

import { afterEach, describe, expect, it } from 'vitest';
import { useState, type ReactElement } from 'react';
import { App } from '../../apps/web/src/App.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SessionStore, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, settle, type Mounted } from './mount.tsx';

const SESSION = { token: 'the-live-token', businessKey: 'alpha', email: 'mia@alpha.local' };

const refusal = (code: string, extra: Record<string, unknown> = {}) => ({
  refused: true,
  code,
  names: [],
  fixes: [],
  ...extra,
});

/** Every call answered `status` with `body`, as the API answers an ended or denied bearer. */
const answering = (body: unknown, status: number): typeof globalThis.fetch =>
  (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )) as unknown as typeof globalThis.fetch;

function storage(): StorageLike {
  const held = new Map([['ops-astro.session', JSON.stringify(SESSION)]]);
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  };
}

function Harness(props: {
  readonly sessions: SessionStore;
  readonly fetch: typeof globalThis.fetch;
}): ReactElement {
  const [path, setPath] = useState('/task/TSK-1');
  return (
    <App
      path={path}
      navigate={setPath}
      sessions={props.sessions}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={props.fetch}
      storage={window.sessionStorage}
    />
  );
}

const live: Mounted[] = [];

/** A reload: the stored session, a new App and so a new client, its first answers `body`. */
async function reloaded(
  body: unknown,
  status: number,
): Promise<{ readonly view: Mounted; readonly sessions: SessionStore }> {
  const sessions = new SessionStore(storage());
  const view = await mount(<Harness sessions={sessions} fetch={answering(body, status)} />);
  live.push(view);
  await settle();
  await settle();
  return { view, sessions };
}

afterEach(async () => {
  await Promise.all(live.splice(0).map((view) => view.unmount()));
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('access ended, heard by a client that has had no earlier answer', () => {
  it('after a reload, the access-ended answer signs the person out to the sign-in screen', async () => {
    const { view, sessions } = await reloaded(refusal('AUTH_ACCESS_ENDED'), 403);
    expect(view.find('#signin-email')).not.toBeNull();
    expect(view.find('[data-reason="session-ended"]')).not.toBeNull();
    expect(view.text()).toContain('AUTH_ACCESS_ENDED');
    expect(sessions.session).toBeNull();
  });

  it('after a reload, an ordinary no-membership denial is drawn and the session kept', async () => {
    const { view, sessions } = await reloaded(refusal('AUTH_NO_MEMBERSHIP'), 403);
    expect(view.find('[data-outcome="denied"]')).not.toBeNull();
    expect(view.text()).toContain('AUTH_NO_MEMBERSHIP');
    expect(view.find('#signin-email')).toBeNull();
    expect(sessions.session).not.toBeNull();
  });
});

/** What `onSessionEnded` heard from one new client over `answers`, in order. */
async function heard(
  answers: readonly (readonly [unknown, number])[],
  signedIn = true,
): Promise<readonly string[]> {
  const queue = answers.map(([body, status]) => Response.json(body, { status }));
  const ended: string[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn,
    fetch: (() => Promise.resolve(queue.shift())) as unknown as typeof globalThis.fetch,
    onSessionEnded: (refused) => ended.push(refused.code),
  });
  for (const _ of answers) {
    // eslint-disable-next-line no-await-in-loop -- one answer per call, in order
    await client.read('task.board', { board: null });
  }
  return ended;
}

describe('the client decides on the code, not on what it remembers', () => {
  it('ends the session on the first answer of a new client when it is 403 access ended', async () => {
    expect(await heard([[refusal('AUTH_ACCESS_ENDED'), 403]])).toEqual(['AUTH_ACCESS_ENDED']);
    // A live call hears it the same way.
    const ended: string[] = [];
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch: answering(refusal('AUTH_ACCESS_ENDED'), 403),
      onSessionEnded: (refused) => ended.push(refused.code),
    });
    expect(await client.live('presence?seat=own-seat&topic=task%3Aown-task', {})).toBeNull();
    expect(ended).toEqual(['AUTH_ACCESS_ENDED']);
  });

  it('returns the access-ended refusal unchanged, and reports nothing when no one was signed in', async () => {
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch: answering(refusal('AUTH_ACCESS_ENDED'), 403),
    });
    expect(await client.read('task.board', { board: null })).toEqual(refusal('AUTH_ACCESS_ENDED'));
    expect(await heard([[refusal('AUTH_ACCESS_ENDED'), 403]], false)).toEqual([]);
  });

  it('keeps the session on a no-membership denial, even after the bearer was served', async () => {
    expect(await heard([[refusal('AUTH_NO_MEMBERSHIP'), 403]])).toEqual([]);
    expect(
      await heard([
        [{ ok: true, tasks: [] }, 200],
        [refusal('SCOPE_NOT_GRANTED'), 403],
        [refusal('AUTH_NO_MEMBERSHIP'), 403],
      ]),
    ).toEqual([]);
  });

  it('ends nothing on a near miss: another status, another spelling, or the words in the body', async () => {
    const nearMisses: readonly (readonly [unknown, number])[] = [
      [refusal('AUTH_ACCESS_ENDED'), 401],
      [refusal('AUTH_ACCESS_ENDED'), 400],
      [refusal('auth_access_ended'), 403],
      [refusal('AUTH_ACCESS_ENDED '), 403],
      [refusal('AUTH_ACCESS_ENDED_SOON'), 403],
      [refusal('AUTH_NO_MEMBERSHIP', { fixes: ['AUTH_ACCESS_ENDED'] }), 403],
      [refusal('AUTH_NO_MEMBERSHIP', { names: ['AUTH_ACCESS_ENDED'], accessEnded: true }), 403],
      [{ code: 'AUTH_ACCESS_ENDED' }, 403],
    ];
    const each = await Promise.all(nearMisses.map(async (answer) => await heard([answer])));
    expect(each).toEqual(nearMisses.map(() => []));
  });
});
