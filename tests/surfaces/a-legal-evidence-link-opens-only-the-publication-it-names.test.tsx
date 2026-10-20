// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// An evidence link (`legalVersionPath`) opened in the app through the real API
// and Postgres: the runbook's link shows its own containment words after a
// newer runbook is published, the public link shows its older words and a
// wrong digest shows nothing, and a runbook link missing half its pin never
// shows a different publication. Bodies kept as the review wrote them.

import { afterAll, beforeAll, expect, it } from 'vitest';
import { act } from 'react';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { legalVersionPath, readPublishedLegal } from '../../packages/core-records/src/index.ts';
import { serverUrl } from '../acceptance/world.ts';
import {
  closeLegal,
  harness,
  openLegal,
  released,
} from '../operations/c81-legal-documents-world.ts';
import { mount, settle } from './mount.tsx';

let runbookPath: string;
let termsPath: string;
const RUNBOOK_WORDS = 'The containment instruction: disconnect the affected machine.';
const TERMS_WORDS = 'The first terms publication: a fixed client promise.';
/** Every request the app sent, answered or not. */
const sent: Promise<Response>[] = [];

beforeAll(async () => {
  if (serverUrl === undefined) return;
  await openLegal('legal_evidence_app');
  await released({ document: 'breach-runbook', version: '1.0', body: RUNBOOK_WORDS });
  await released({ document: 'client-terms', version: '1.0', body: TERMS_WORDS });
  const paths = await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
    const runbook = await readPublishedLegal(tx, 'breach-runbook');
    const terms = await readPublishedLegal(tx, 'client-terms');
    if (runbook === undefined || terms === undefined) throw new Error('Missing publication');
    return { runbook: legalVersionPath('alpha', runbook), terms: legalVersionPath('alpha', terms) };
  });
  runbookPath = paths.runbook;
  termsPath = paths.terms;
  await released({
    document: 'breach-runbook',
    version: '2.0',
    body: 'The newer containment procedure.',
  });
  await released({ document: 'client-terms', version: '2.0', body: 'The newer client promise.' });
}, 180_000);

afterAll(async () => {
  // A test ends once its screen shows, while the app's other reads (the
  // person, preferences, inbox count) are still on their way. Closing the
  // database under them threw a closed-connection rejection outside every
  // test, a red run with every test green, so they are answered first.
  await Promise.allSettled(sent);
  if (serverUrl !== undefined) await closeLegal();
});

/** Noah's session held, or none. */
function sessionsFor(signedIn: boolean): SessionStore {
  const session = {
    token: harness.world.noah.token,
    businessKey: 'alpha',
    email: 'noah@alpha.local',
  };
  const held = new Map<string, string>(
    signedIn ? [['ops-astro.session', JSON.stringify(session)]] : [],
  );
  return new SessionStore({
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  });
}

async function open(path: string, signedIn: boolean) {
  const sessions = sessionsFor(signedIn);
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (signedIn && !String(url).startsWith('/api/public/')) {
      headers.set('authorization', `Bearer ${harness.world.noah.token}`);
    }
    const response = Promise.resolve(harness.world.api.request(String(url), { ...init, headers }));
    sent.push(response);
    return response;
  }) as typeof globalThis.fetch;
  const view = await mount(
    <App
      path={path}
      navigate={() => {}}
      sessions={sessions}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={fetch}
      storage={window.sessionStorage}
    />,
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each settle waits on the one before
    await settle();
    if (
      view.find('[data-runbook]') !== null ||
      view.find('[data-paragraph]') !== null ||
      view.find('[data-outcome="not-published"]') !== null ||
      view.find('[data-outcome="denied"]') !== null
    )
      break;
    // oxlint-disable-next-line no-await-in-loop -- polled one step at a time
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    });
  }
  return view;
}

it.skipIf(serverUrl === undefined)(
  'a generated runbook evidence link shows its containment instruction through the real route',
  async () => {
    const view = await open(runbookPath, true);
    expect(view.find('[data-runbook]')?.textContent).toContain('version 1.0');
    await view.click('[data-runbook-body] summary');
    expect(view.find('[data-runbook-body]')?.textContent).toContain(RUNBOOK_WORDS);
    expect(view.find('[data-runbook-body]')?.textContent).not.toContain(
      'The newer containment procedure.',
    );
  },
);

it.skipIf(serverUrl === undefined)(
  'a generated public evidence link shows its older words and refuses the wrong digest',
  async () => {
    const view = await open(termsPath, false);
    expect(view.find('[data-screen="legal"]')?.textContent).toContain('Version 1.0');
    expect(view.find('[data-paragraph]')?.textContent).toBe(TERMS_WORDS);
    await view.unmount();
    const wrong = termsPath.replace(/digest=[^&]+/u, `digest=${'0'.repeat(64)}`);
    const refused = await open(wrong, false);
    expect(refused.find('[data-outcome="not-published"]')).not.toBeNull();
    expect(refused.find('[data-paragraph]')).toBeNull();
  },
);

it.skipIf(serverUrl === undefined)(
  'a runbook evidence address with half its pin missing cannot show a different publication',
  async () => {
    const half = runbookPath.replace(/&digest=[^&]+/u, '');
    const view = await open(half, true);
    expect(view.find('[data-runbook]')?.textContent ?? '').not.toContain('version 2.0');
    expect(view.find('[data-runbook-body]')?.textContent ?? '').not.toContain(
      'The newer containment procedure.',
    );
  },
);
