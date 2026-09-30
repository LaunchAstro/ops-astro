// SPDX-License-Identifier: AGPL-3.0-only
// S0-2 canary, continued: a planted secret, record content or identifier-shaped
// name never reaches the sink, the API log or an alert. The set-up is
// s0-2-canary.fixture.ts; the first cases are in s0-2-canary.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PREFIX } from '../../packages/core-wire/src/index.ts';
import { bearer, READ_PATH, served } from './s0-2-canary.fixture.ts';
import { times } from './s0-2-plain.ts';

const CANARY_SECRET = 'canary-S02CANARY-4e8a1c-alert-secret';

const RECORD_CONTENT = 'Private note: client Juniper Vale owes 4,210';

afterEach(() => vi.restoreAllMocks());

describe('S0-2 canary', () => {
  canaryCases5();
  canaryCases6();
  canaryCases7();
});

function canaryCases5() {
  it('an identifier-shaped planted error name never reaches the API log', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(
      (...parts: unknown[]) => void logged.push(parts.join(' ')),
    );
    const planted = new Error('a fault');
    planted.name = 'CanarySecretLettersOnly';
    const { app, events, alerts } = served(() => Promise.reject(planted));
    const response = await app.fetch(
      new Request(`http://api.test${PREFIX.person}alpha${READ_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await bearer('person-one')}`,
        },
        body: '{}',
      }),
    );
    await alerts.settled();
    expect(response.status).toBe(503);
    expect(events).toHaveLength(1);
    expect(logged.join('\n').includes('CanarySecretLettersOnly'), 'the planted secret').toBe(false);
  });
}

function canaryCases6() {
  it('a fault carrying a planted secret and record content reaches the sink without either', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(
      (...parts: unknown[]) => void logged.push(parts.join(' ')),
    );
    const { app, events, alerts } = served(() =>
      Promise.reject(new Error(`${CANARY_SECRET} ${RECORD_CONTENT}`)),
    );
    const response = await app.fetch(
      new Request(`http://api.test${PREFIX.person}alpha${READ_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await bearer(CANARY_SECRET)}`,
        },
        body: JSON.stringify({ note: RECORD_CONTENT, key: CANARY_SECRET }),
      }),
    );
    await alerts.settled();
    const answered = await response.text();
    expect(response.status).toBe(503);
    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe('error');
    for (const place of [JSON.stringify(events), logged.join('\n'), answered]) {
      // Booleans, so a failure message never prints what it found.
      expect(place.includes('S02CANARY'), 'the planted secret').toBe(false);
      expect(place.includes('Juniper'), 'the planted content').toBe(false);
    }
  });
}

function canaryCases7() {
  it('refusals of a subject that is the planted secret raise an alert that does not carry it', async () => {
    const { app, events, alerts } = served(() => Promise.reject(new Error('unused')));
    await times(10, async () => {
      const response = await app.fetch(
        new Request(`http://api.test${PREFIX.person}nobody-${CANARY_SECRET}${READ_PATH}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${await bearer(CANARY_SECRET)}`,
          },
          body: JSON.stringify({ note: RECORD_CONTENT }),
        }),
      );
      expect(response.status).toBe(403);
    });
    await alerts.settled();
    expect(events.map((e) => e.tags['alert'])).toEqual(['cross-scope-burst']);
    expect(JSON.stringify(events).includes('S02CANARY'), 'the planted secret').toBe(false);
    expect(JSON.stringify(events).includes('Juniper'), 'the planted content').toBe(false);
  });
}
