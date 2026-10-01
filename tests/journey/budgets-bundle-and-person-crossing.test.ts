// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function, no-useless-undefined, require-await
   -- the proof's body is kept as reviewed, byte for byte. */

import { describe, expect, it, vi } from 'vitest';
import { commandBudgets, writeBundle } from '../../scripts/local/journey-bundle.ts';
import { crossings, type Cast } from './separation.ts';
import type { PassContext, PassResult } from './passes.ts';
import type { World } from '../acceptance/world.ts';

describe('journey budgets, the bundle and a same-business crossing', () => {
  it('an unmeasured migration cannot pass its budget', () => {
    const [migration] = commandBudgets(undefined, 1000, undefined);
    expect(migration?.['status']).not.toBe('pass');
    const [failedStart] = commandBudgets(0, 1000, undefined);
    expect(failedStart?.['status']).not.toBe('pass');
  });

  it('bundle excludes client-authored approval notes', () => {
    const note = 'Client Quokka confidential treatment plan';
    const approval = {
      taskId: 'task-1',
      decisionId: 'decision-1',
      decision: 'approve',
      action: JSON.stringify({ decision: 'approve', note }),
    };
    const bundle = writeBundle({
      head: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      clean: true,
      identity: '{}',
      environment: {},
      cases: [],
      budgets: [],
      crashPoints: '',
      approval,
    });
    expect(bundle.json).not.toContain(note);
    expect(bundle.markdown).not.toContain(note);
  });

  it('journey isolation attempts a same-business person crossing', async () => {
    const seen = new Set<string>();
    vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
      // The credential each call carried: the CLI's bearer, or the app's
      // session cookie (S0-6c), whose value is the person's token.
      const headers = new Headers(options.headers);
      const cookie = headers.get('cookie');
      seen.add(
        headers.get('authorization') ??
          (cookie === null ? '' : `Cookie ${cookie.replace(/^[^=]*=/u, '')}`),
      );
      return new Response(JSON.stringify({ refused: true, code: 'NOT_FOUND' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    });
    const context: PassContext = {
      world: {
        ada: { token: 'ops-astro-test-only-owner' },
        bea: { token: 'ops-astro-test-only-other-business' },
        noah: { token: 'ops-astro-test-only-same-business-other-person' },
        agent: { token: 'ops-astro-test-only-agent' },
      } as World,
      api: 'http://127.0.0.1:1',
      app: 'http://127.0.0.1:1',
      title: 'Owner task',
    };
    const cast: Cast = {
      canary: { id: 'foreign-task', title: 'Foreign task' },
      external: { token: 'ops-astro-test-only-other-client' } as Cast['external'],
      shared: { id: 'shared-task', delegation: 'held' },
    };
    const pass = {
      surface: 'app',
      taskId: 'owner-task',
      answers: [],
      sent: [],
      facts: {
        decisions: [],
        receipt: null,
        reservations: [],
        attempts: [],
        events: [],
        audit: [],
        alerts: [],
      },
    } as PassResult;
    try {
      await crossings(context, cast, [pass]);
      expect(seen).toContain('Cookie ops-astro-test-only-same-business-other-person');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
