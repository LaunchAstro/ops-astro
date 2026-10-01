// SPDX-License-Identifier: AGPL-3.0-only
//
// C81: versioned legal documents through the real API: two publishes at once,
// the public read with no sign-in, the refusals under `privacy:manage`, and an
// unpublished draft's canary. The world is `c81-legal-documents-world.ts`.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { publishLegalVersion } from '../../packages/core-records/src/operations/legal-documents.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { serverUrl } from '../acceptance/world.ts';
import {
  approve,
  CANARY,
  clientToken,
  closeLegal,
  detailOf,
  digestOf,
  draft,
  draftBody,
  harness,
  openLegal,
  publish,
  readPublic,
  released,
  versionRows,
} from './c81-legal-documents-world.ts';

if (serverUrl === undefined) {
  console.warn(
    'operations/c81-legal-documents-access: DATABASE_URL is unset, so nothing below ran.',
  );
}

beforeAll(async () => {
  if (serverUrl !== undefined) await openLegal('c81_legal_access');
}, 120_000);

afterAll(async () => {
  if (serverUrl !== undefined) await closeLegal();
});

describe.skipIf(serverUrl === undefined)('C81 the legal documents', () => {
  it('C81 two publishes at once: one publishes, the other is told it already is, and nothing raises', async () => {
    const body = draftBody({ document: 'breach-runbook' });
    const versionId = String(detailOf(await draft(body))['versionId']);
    expect((await approve(versionId, digestOf(body.body))).code).toBe('ok');
    const actorId = harness.world.ada.actorId as string;
    // Two connections, so the two transactions truly overlap: the first holds
    // its lock for 300 ms after publishing, and the second arrives meanwhile.
    const wide = connect(harness.world.db.appUrl, { source: 'runtime', max: 2 });
    const first = wide.withBusiness(harness.world.alpha, async (tx) => {
      const refusal = await publishLegalVersion(tx, versionId, actorId);
      await tx.query('select pg_sleep(0.3)');
      return refusal;
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    const second = wide.withBusiness(
      harness.world.alpha,
      async (tx) => await publishLegalVersion(tx, versionId, actorId),
    );
    const outcomes = await Promise.allSettled([first, second]).finally(
      async () => await wide.close(),
    );
    expect(outcomes).toEqual([
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: 'already-published' },
    ]);
  });
});

describe.skipIf(serverUrl === undefined)('C81 the legal documents', () => {
  it('C81 public without sign-in: each published document is read with no credential; the breach runbook never is', async () => {
    for (const document of ['privacy-policy', 'client-terms', 'data-handling']) {
      // oxlint-disable-next-line no-await-in-loop
      const { body } = await released({ document });
      // oxlint-disable-next-line no-await-in-loop
      const shown = await readPublic('alpha', document);
      expect(shown.status, document).toBe(200);
      expect(JSON.parse(shown.text), document).toMatchObject({ document, body: body.body });
      expect(Date.parse(String(JSON.parse(shown.text).publishedAt)), document).not.toBeNaN();
    }
    // The breach runbook is published for the operators, never to the public.
    const runbook = await released({ document: 'breach-runbook' });
    const hidden = await readPublic('alpha', 'breach-runbook');
    expect(hidden.status).toBe(404);
    expect(hidden.text).not.toContain(runbook.body.body);

    // Nothing published, no business and no such document are one answer.
    const nobody = await readPublic('no-such-business', 'privacy-policy');
    const unknown = await readPublic('alpha', 'hire-agreement');
    expect(nobody.status).toBe(404);
    expect(unknown).toEqual(nobody);
    expect(hidden).toEqual(nobody);
  });

  it('C81 refusal privacy:manage: a holder of operations:read alone, a member and a client are refused all three, and nothing is written', async () => {
    const drafted = await draft();
    const versionId = detailOf(drafted)['versionId'];
    const before = await versionRows(harness.world.alpha);
    for (const token of [harness.world.noah.token, harness.world.mia.token, clientToken]) {
      const answers = [
        // oxlint-disable-next-line no-await-in-loop
        await draft(draftBody(), token),
        // oxlint-disable-next-line no-await-in-loop
        await approve(versionId, digestOf('x'), token),
        // oxlint-disable-next-line no-await-in-loop
        await publish(versionId, token),
      ];
      for (const answer of answers) {
        expect({ status: answer.status, code: answer.code }).toEqual({
          status: 403,
          code: 'SCOPE_NOT_GRANTED',
        });
      }
    }
    expect(await versionRows(harness.world.alpha)).toEqual(before);
  });
});

describe.skipIf(serverUrl === undefined)('C81 the legal documents', () => {
  it('C81 isolation: an unpublished draft reaches no log, audit row, operation register row, refusal or public read', async () => {
    const logged: string[] = [];
    const capture = (...parts: unknown[]) => void logged.push(parts.map(String).join(' '));
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(capture),
    );
    let versionId: unknown;
    try {
      const drafted = await draft(draftBody({ document: 'privacy-policy', body: CANARY }));
      expect(drafted.status).toBe(200);
      versionId = detailOf(drafted)['versionId'];
      const answers = [
        await draft(draftBody({ body: CANARY }), harness.world.mia.token),
        await draft(draftBody({ body: CANARY }), harness.world.bea.token, 'alpha'),
        await approve(versionId, digestOf(`${CANARY}!`)),
        await publish(versionId),
        await publish(versionId, harness.world.bea.token, 'bravo'),
      ];
      for (const answer of answers) {
        expect(answer.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(answer.body)).not.toContain(CANARY);
      }
      for (const key of ['alpha', 'bravo']) {
        // oxlint-disable-next-line no-await-in-loop
        expect((await readPublic(key, 'privacy-policy')).text).not.toContain(CANARY);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(logged.join('\n')).not.toContain(CANARY);

    const stored = await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) =>
      tx.query<{ readonly row: string }>(
        `select to_jsonb(e)::text as row from public.audit_events e where command like 'legal.%'
         union all
         select to_jsonb(o)::text from public.operations o where command like 'legal.%'`,
      ),
    );
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.map((row) => row.row).join('\n')).not.toContain(CANARY);
  });
});
