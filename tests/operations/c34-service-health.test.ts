// SPDX-License-Identifier: AGPL-3.0-only
//
// C34: the service-health section of the operations view, through the real
// API. `operations.read` carries it beside C55's privacy incidents: one read,
// never a second page. The watcher and the error sink are stood in for at the
// port their adapters fill (C29-1, C29-3); the tracing read is this ticket's
// own adapter, called over HTTP against a stand-in Langfuse on a loopback
// port, so every hostile answer reaches it the way a real one would.
//
// Ada is alpha's owner and holds `operations:read`; Mia holds no such key;
// Bea is bravo's owner and holds it there. A client of alpha holds a share
// and nothing else, and the agent acts under a live delegation from Ada.

import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { HEALTH_STALE_SECONDS, type SourceAnswer } from '../../packages/core-commands/src/index.ts';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/surface.ts';
import { agentPath, bearer, call, personPath, serverUrl } from '../acceptance/world.ts';
import {
  CANARY,
  seen,
  answers,
  statesOf,
  json,
  UNREADABLE,
  HOSTILE_LANGFUSE,
  harness,
  credential,
  clientToken,
  replyAsLangfuse,
  heard,
  watcher,
  errorSink,
  apiWith,
  tracing,
  view,
  healthOf,
  tracingOf,
  useHealthWorld,
} from './c34-service-health-world.ts';

useHealthWorld();

describe.skipIf(serverUrl === undefined)('C34 service health on the operations view', () => {
  it('C34 service health: never observed, stale, read failure and service failure are kept distinct', async () => {
    watcher.answer = answers(
      seen('api', true, 60),
      seen('worker', false, 60),
      seen('mailer', null, null),
      seen('scheduler', true, HEALTH_STALE_SECONDS + 60),
      // Down, but last seen so long ago that "down" is not known now.
      seen('importer', false, HEALTH_STALE_SECONDS + 60),
    );
    errorSink.answer = async () =>
      await Promise.resolve<SourceAnswer>({ ok: false, fault: 'slow' });
    const section = await healthOf(apiWith({ watcher, errorSink }));

    expect(section.sources).toEqual([
      { source: 'watcher', state: 'read', fault: null },
      { source: 'error-sink', state: 'read-failure', fault: 'slow' },
      // Switched off, which is not a failure.
      { source: 'tracing', state: 'off', fault: null },
    ]);
    expect(statesOf(section)).toEqual({
      'watcher:api': 'healthy',
      'watcher:worker': 'service-failure',
      'watcher:mailer': 'never-observed',
      'watcher:scheduler': 'stale',
      'watcher:importer': 'stale',
    });
    expect(section.services.find((row) => row.name === 'mailer')?.lastObservedAt).toBeNull();
    expect(Date.parse(section.checkedAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('C34 service health: a stopped worker shows as a service failure, and the others healthy', async () => {
    watcher.answer = answers(
      seen('api', true, 30),
      seen('worker', false, 30),
      seen('web', true, 30),
    );
    errorSink.answer = answers(seen('error sink', true, 30));
    const section = await healthOf(apiWith({ watcher, errorSink, tracing: tracing() }));
    expect(statesOf(section)).toEqual({
      'watcher:api': 'healthy',
      'watcher:worker': 'service-failure',
      'watcher:web': 'healthy',
      'error-sink:error sink': 'healthy',
      'tracing:tracing': 'healthy',
    });
    expect(section.sources.map((row) => row.state)).toEqual(['read', 'read', 'read']);
  });
});
describe.skipIf(serverUrl === undefined)('C34 service health on the operations view', () => {
  it('C34 service health: a source that cannot be read is a read failure, never a service failure', async () => {
    for (const [name, answer, fault] of UNREADABLE) {
      watcher.answer = answer;
      // oxlint-disable-next-line no-await-in-loop
      const section = await healthOf(apiWith({ watcher, errorSink, timeoutMs: 300 }));
      expect(section.sources[0], name).toEqual({ source: 'watcher', state: 'read-failure', fault });
      // Nothing the source said is shown when it could not be read whole.
      expect(
        section.services.filter((row) => row.source === 'watcher'),
        name,
      ).toEqual([]);
      expect(JSON.stringify(section), name).not.toContain(CANARY);
    }

    // No source configured: the watcher and the error sink are read failures
    // (they are not optional), and tracing is off.
    const bare = await healthOf(apiWith());
    expect(bare.sources).toEqual([
      { source: 'watcher', state: 'read-failure', fault: 'unconfigured' },
      { source: 'error-sink', state: 'read-failure', fault: 'unconfigured' },
      { source: 'tracing', state: 'off', fault: null },
    ]);
  });

  it('C34 tracing read: Langfuse healthy and Langfuse failing are two answers, read at its health route', async () => {
    const api = apiWith({ watcher, errorSink, tracing: tracing() });

    expect(await tracingOf(api)).toEqual({
      source: { source: 'tracing', state: 'read', fault: null },
      states: ['healthy'],
    });
    // Called at its health route under the configured base, with no credential.
    expect(heard).toEqual([{ route: 'GET /langfuse/api/public/health', authorization: undefined }]);

    replyAsLangfuse(json(503, { status: 'Database not available' }));
    expect(await tracingOf(api)).toEqual({
      source: { source: 'tracing', state: 'read', fault: null },
      states: ['service-failure'],
    });
  });
});
describe.skipIf(serverUrl === undefined)('C34 service health on the operations view', () => {
  it('C34 tracing read: a hostile or malformed Langfuse answer is a read failure, never healthy', async () => {
    const api = apiWith({ watcher, errorSink, tracing: tracing() });
    for (const [name, reply, fault] of HOSTILE_LANGFUSE) {
      replyAsLangfuse(reply);
      // oxlint-disable-next-line no-await-in-loop
      const read = await tracingOf(api);
      expect(read, name).toEqual({
        source: { source: 'tracing', state: 'read-failure', fault },
        states: [],
      });
      expect(JSON.stringify(read), name).not.toContain(CANARY);
    }
    expect(heard.every((row) => row.route === 'GET /langfuse/api/public/health')).toBe(true);
  }, 60_000);

  it('C34 one read: the section comes with the operations view, each source asked once, and by nothing else', async () => {
    const api = apiWith({ watcher, errorSink, tracing: tracing() });
    const [watcherBefore, sinkBefore] = [watcher.calls, errorSink.calls];
    const answer = await view(api);
    expect(answer.status).toBe(200);
    expect(Object.keys(answer.body).toSorted()).toEqual([
      'breachRunbook',
      'lastTestedRestore',
      'ok',
      'privacyIncidents',
      'securityAlerts',
      'serviceHealth',
      'unattended',
    ]);
    expect([watcher.calls - watcherBefore, errorSink.calls - sinkBefore, heard.length]).toEqual([
      1, 1, 1,
    ]);

    // Another read asks no source.
    const capabilities = await call(
      api,
      personPath('alpha', '/session/capabilities'),
      {},
      bearer(harness.world.ada.token),
    );
    expect(capabilities.status).toBe(200);
    expect(capabilities.body['serviceHealth']).toBeUndefined();
    expect([watcher.calls - watcherBefore, errorSink.calls - sinkBefore, heard.length]).toEqual([
      1, 1, 1,
    ]);
  });
});
describe.skipIf(serverUrl === undefined)('C34 service health on the operations view', () => {
  it('C34 isolation: another business, another client and a delegated agent', async () => {
    watcher.answer = answers(seen('api', true, 30), {
      ...seen(`${CANARY} client site`, false, 30),
      scope: 'client-site',
    });
    const api = apiWith({ watcher, errorSink, tracing: tracing() });

    // Another business: bravo's holder sees the installation's services and
    // no client's site; alpha's view shows no client's site either.
    for (const [token, key] of [
      [harness.world.bea.token, 'bravo'],
      [harness.world.ada.token, 'alpha'],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const section = await healthOf(api, token, key);
      expect(
        section.services.map((row) => row.name),
        key,
      ).toEqual(['api', 'tracing']);
      expect(JSON.stringify(section), key).not.toContain(CANARY);
    }
    expect((await view(api, harness.world.bea.token, 'alpha')).code).toBe('AUTH_NO_MEMBERSHIP');

    // Another client in the same business, and a member without the key:
    // refused, and no source is asked.
    const [watcherBefore, heardBefore] = [watcher.calls, heard.length];
    for (const token of [clientToken, harness.world.mia.token]) {
      // oxlint-disable-next-line no-await-in-loop
      const refused = await view(api, token);
      expect(refused.status).toBe(403);
      expect(refused.body['serviceHealth']).toBeUndefined();
    }

    // Another person under a live delegation: the agent acting for Ada, who
    // holds the key, is refused on the agent prefix, and no source is asked.
    const agent = await call(
      api,
      agentPath('alpha', '/operations/read'),
      { operationId: randomUUID() },
      { ...bearer(harness.world.agent.token), [DELEGATION_HEADER]: credential },
    );
    expect(agent.status).toBe(403);
    expect(agent.code).toBe('DELEGATION_EXCLUDES_OPERATION');
    expect([watcher.calls, heard.length]).toEqual([watcherBefore, heardBefore]);
  });
});
describe.skipIf(serverUrl === undefined)('C34 service health on the operations view', () => {
  it('C34 canary: a source’s words reach no answer, refusal or log', async () => {
    const logged: string[] = [];
    const capture = (...parts: unknown[]) => void logged.push(parts.map(String).join(' '));
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(capture),
    );
    try {
      watcher.answer = async () => await Promise.reject(new Error(CANARY));
      errorSink.answer = answers({ ...seen(CANARY, true, 10), scope: 'client-site' });
      replyAsLangfuse(json(500, { status: CANARY }));
      const api = apiWith({ watcher, errorSink, tracing: tracing() });
      const served = [
        await view(api),
        await view(api, harness.world.mia.token),
        await view(api, clientToken),
      ];
      for (const answer of served) expect(JSON.stringify(answer)).not.toContain(CANARY);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(logged.join('\n')).not.toContain(CANARY);
  });
});
