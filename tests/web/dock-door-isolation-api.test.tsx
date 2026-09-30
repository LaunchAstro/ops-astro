// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-3-4 isolation and MP-3-5 isolation: the crossings of MP-3-1 isolation
// (tests/web/mp-3-1-isolation-api.test.tsx, whose world this shares) through
// a programmatic door and through the dock's history, against the real
// boundary and a fresh Postgres.

import { describe, expect, it } from 'vitest';
import { act } from 'react';
import type { Session } from '../../apps/web/src/session/token.ts';
import { tokenFor } from '../api/fixture.ts';
import {
  isolationWorld,
  memory,
  plant,
  quiet,
  readsOf,
  serverUrl,
  signedIn,
  throughDoor,
  type Heard,
} from './mp-3-1-isolation-world.tsx';

const w = isolationWorld('dock_door_isolation');

// MP-3-4 isolation: the same crossings through a programmatic door, a row
// or badge naming the view it opens. The door is followed; what it names is
// read under the clicker's own session, and the server refuses it.
describe.skipIf(serverUrl === undefined)('MP-3-1 isolation', () => {
  it('MP-3-4 isolation: its own reader follows the door to the canary', async () => {
    const { page, reads } = await throughDoor(w, {
      token: await tokenFor(w.clientOne.presented.subject),
      businessKey: 'alpha',
      email: 'one@example.test',
    });
    expect(page.find('[data-panel-id="todos"]')?.textContent).toContain(w.canary);
    expect(reads.map((each) => each.status)).toContain(200);
  });

  it('MP-3-4 isolation: another client, another business and a delegated agent are refused', async () => {
    const sessions: readonly Session[] = [
      {
        token: await tokenFor(w.clientTwo.presented.subject),
        businessKey: 'alpha',
        email: 'two@example.test',
      },
      {
        token: await tokenFor(w.both.presented.subject),
        businessKey: 'bravo',
        email: 'both@example.test',
      },
      {
        token: await tokenFor(w.fixture.agent.subject),
        businessKey: 'alpha',
        email: 'agent@example.test',
      },
    ];
    for (const session of sessions) {
      // eslint-disable-next-line no-await-in-loop -- one mounted application at a time
      const { page, reads, heard } = await throughDoor(w, session);
      // A person route that does not know the caller ends the session before
      // the door can open anything; otherwise the door opened and was refused.
      if (heard.some((each) => each.status === 401)) {
        expect(page.all('.dpanel'), session.email).toHaveLength(0);
      } else {
        expect(page.all('.dpanel').length, session.email).toBe(1);
        expect(reads.length, session.email).toBeGreaterThan(0);
      }
      for (const read of reads) expect([401, 403, 404], session.email).toContain(read.status);
      expect(page.text(), session.email).not.toContain(w.canary);
    }
  });
});

describe.skipIf(serverUrl === undefined)('MP-3-1 isolation', () => {
  // MP-3-5 isolation: the dock's history never reopens a record the person
  // can no longer read. A walk back puts the panel on the task again, and the
  // panel reads it again under the session in hand, which the server refuses
  // once the grant is gone. (Another business or person starts a history of
  // its own: tests/web/dock-history-app.test.tsx.)
  it('MP-3-5 isolation: back to a task whose grant was revoked is refused', async () => {
    const storage = memory();
    const session = {
      token: await tokenFor(w.revoked.presented.subject),
      businessKey: 'alpha',
      email: 'revoked@example.test',
    };
    plant(storage, 'alpha', session.email, `/task/${w.taskOne}`);
    const heard: Heard[] = [];
    const page = await signedIn(w, session, storage, heard);
    expect(page.find('[data-panel-id="todos"]')?.textContent).toContain(w.canary);
    expect(readsOf(w, heard).map((each) => each.status)).toContain(200);

    const link = document.createElement('a');
    link.setAttribute('href', '/projects/');
    (page.find('[data-panel-id="todos"] .dpanel__body') as HTMLElement).append(link);
    await act(() => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await quiet(heard);
    expect(page.text()).not.toContain(w.canary);

    const revoke = await w.controls.asPerson('grant.revoke', { grantId: w.revokedGrant });
    expect(revoke.status).toBe(200);
    const asked = heard.length;
    await page.click('[data-panel-id="todos"] [data-act="back"]');
    await quiet(heard);
    const again = readsOf(w, heard.slice(asked));
    expect(again.length).toBeGreaterThan(0);
    for (const read of again) expect([403, 404]).toContain(read.status);
    expect(page.text()).not.toContain(w.canary);
  });
});
