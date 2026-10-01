// SPDX-License-Identifier: AGPL-3.0-only
//
// C81: the legal documents, each a run of versions: drafted
// (`legal.draft_version`, `legal document version drafted`), approved as that
// exact version (`legal.approve_version`, `legal document version approved`)
// and published (`legal.publish_version`, `legal document published`), every
// one under `privacy:manage` and never an agent's. A published version is read
// at a public address that needs no sign-in; the breach runbook is the one
// document that is never public.
//
// Ada is alpha's owner and holds `privacy:manage` (the acceptance cast's admin
// collections); Noah holds `operations:read` alone; Mia holds neither; Bea is
// bravo's owner and holds `privacy:manage` there. A client of alpha holds a
// share and nothing else, and the agent acts under a live delegation from Ada.
//
// The world is `c81-legal-documents-world.ts`; the race, the public read, the
// refusals and the draft canary are in `c81-legal-documents-access.test.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/surface.ts';
import { agentPath, bearer, call, serverUrl } from '../acceptance/world.ts';
import {
  approve,
  clientToken,
  closeLegal,
  credential,
  detailOf,
  digestOf,
  draft,
  draftBody,
  harness,
  type Name,
  NAMES,
  nextVersion,
  openLegal,
  pathOf,
  publish,
  readPublic,
  released,
  versionRows,
} from './c81-legal-documents-world.ts';

if (serverUrl === undefined) {
  console.warn('operations/c81-legal-documents: DATABASE_URL is unset, so nothing below ran.');
}

beforeAll(async () => {
  if (serverUrl !== undefined) await openLegal('c81_legal');
}, 120_000);

afterAll(async () => {
  if (serverUrl !== undefined) await closeLegal();
});

async function c81ExactVersionApprovalOnlyTheVersion(): Promise<void> {
  const first = draftBody();
  const drafted = await draft(first);
  expect(drafted.status).toBe(200);
  const firstId = detailOf(drafted)['versionId'];
  expect(detailOf(drafted)['digest']).toBe(digestOf(first.body));

  // Unapproved: refused, and nothing is published.
  const early = await publish(firstId);
  expect({ status: early.status, code: early.code }).toEqual({
    status: 409,
    code: 'LEGAL_NOT_APPROVED',
  });

  // Approval names the bytes the approver read; other bytes are refused.
  const wrong = await approve(firstId, digestOf(`${first.body} changed`));
  expect({ status: wrong.status, code: wrong.code }).toEqual({
    status: 409,
    code: 'LEGAL_DIGEST_MISMATCH',
  });

  // A second version approved does not approve the first.
  const second = draftBody({ version: nextVersion() });
  const secondId = detailOf(await draft(second))['versionId'];
  // The second version's digest does not approve the first version.
  const crossed = await approve(firstId, digestOf(second.body));
  expect(crossed.code).toBe('LEGAL_DIGEST_MISMATCH');
  expect((await approve(secondId, digestOf(second.body))).code).toBe('ok');
  const other = await publish(firstId);
  expect({ status: other.status, code: other.code }).toEqual({
    status: 409,
    code: 'LEGAL_NOT_APPROVED',
  });
  expect((await readPublic('alpha', 'privacy-policy')).status).toBe(404);

  // The approved one publishes, once, and is what the public address serves.
  expect((await publish(secondId)).code).toBe('ok');
  const again = await publish(secondId);
  expect({ status: again.status, code: again.code }).toEqual({
    status: 409,
    code: 'LEGAL_ALREADY_PUBLISHED',
  });
  const approvedTwice = await approve(secondId, digestOf(second.body));
  expect(approvedTwice.code).toBe('LEGAL_ALREADY_APPROVED');
  const shown = await readPublic('alpha', 'privacy-policy');
  expect(shown.status).toBe(200);
  expect(JSON.parse(shown.text)).toMatchObject({
    document: 'privacy-policy',
    version: second.version,
    body: second.body,
    digest: digestOf(second.body),
  });

  // Each act is audited as its own tracked action.
  const events = await harness.world.db.app.withBusiness(harness.world.alpha, (tx) =>
    tx.query<{ readonly command: string; readonly outcome: string }>(
      `select command, outcome from public.audit_events
        where command like 'legal.%' and outcome = 'applied' order by seq`,
    ),
  );
  expect(new Set(events.map((event) => event.command))).toEqual(new Set(NAMES));
}

async function c81PublishedVersionUnchangedAnInPlace(): Promise<void> {
  const { versionId, body } = await released({ document: 'client-terms' });
  const before = await readPublic('alpha', 'client-terms');
  expect(before.status).toBe(200);

  // Through the API: the same version drafted again is refused.
  const redraft = await draft(
    draftBody({ document: 'client-terms', version: body.version, body: 'Other words.' }),
  );
  expect({ status: redraft.status, code: redraft.code }).toEqual({
    status: 409,
    code: 'LEGAL_VERSION_EXISTS',
  });

  // Under the application's own role: the words, the version, the approval
  // and the publication are each refused in place, and nothing is deleted.
  const attempts = [
    `update public.legal_document_versions set body = 'Other words.' where id = $1`,
    `update public.legal_document_versions set version = '9.9' where id = $1`,
    `update public.legal_document_versions set published_at = null where id = $1`,
    `update public.legal_document_versions set approved_digest = repeat('0', 64) where id = $1`,
    `delete from public.legal_document_versions where id = $1`,
  ];
  for (const sql of attempts) {
    // oxlint-disable-next-line no-await-in-loop
    const outcome = await harness.world.db.app
      .withBusiness(harness.world.alpha, async (tx) => await tx.query(sql, [versionId]))
      .then(
        () => 'changed',
        () => 'refused',
      );
    expect(outcome, sql).toBe('refused');
  }
  const after = await readPublic('alpha', 'client-terms');
  expect(after).toEqual(before);
  expect(JSON.parse(after.text)).toMatchObject({ body: body.body, digest: digestOf(body.body) });

  // A change is a new version the owner approves; the old bytes stay as they were.
  const next = await released({ document: 'client-terms', body: 'Client terms, revised.\n' });
  const current = await readPublic('alpha', 'client-terms');
  expect(JSON.parse(current.text)).toMatchObject({ version: next.body.version });
  const kept = await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) =>
    tx.query<{ readonly body: string }>(
      'select body from public.legal_document_versions where id = $1',
      [versionId],
    ),
  );
  expect(kept).toEqual([{ body: body.body }]);
}

async function c81IsolationAnotherBusinessAnotherClientAnd(): Promise<void> {
  const alphaDraft = draftBody({ document: 'data-handling', body: `alpha only ${randomUUID()}` });
  const alphaId = detailOf(await draft(alphaDraft))['versionId'];
  const alphaCount = await versionRows(harness.world.alpha);

  // Another business: Bea publishes bravo's own; bravo's address shows
  // bravo's words only, and alpha's version is not found from bravo.
  const bravo = await released(
    { document: 'data-handling', body: `bravo only ${randomUUID()}` },
    harness.world.bea.token,
    'bravo',
  );
  const bravoShown = await readPublic('bravo', 'data-handling');
  expect(JSON.parse(bravoShown.text)).toMatchObject({ body: bravo.body.body });
  const madeUp = await publish(randomUUID(), harness.world.bea.token, 'bravo');
  for (const answer of [
    await approve(alphaId, digestOf(alphaDraft.body), harness.world.bea.token, 'bravo'),
    await publish(alphaId, harness.world.bea.token, 'bravo'),
  ]) {
    expect({ status: answer.status, body: answer.body }).toEqual({
      status: madeUp.status,
      body: madeUp.body,
    });
  }
  // Bea on alpha's prefix is no member of alpha.
  const across = await draft(draftBody(), harness.world.bea.token, 'alpha');
  expect({ status: across.status, code: across.code }).toEqual({
    status: 403,
    code: 'AUTH_NO_MEMBERSHIP',
  });

  // Another client in the same business: a share reaches none of the three.
  const client = await approve(alphaId, digestOf(alphaDraft.body), clientToken);
  expect(client.status).toBe(403);
  expect(JSON.stringify(client.body)).not.toContain(alphaDraft.body);

  // Another person under a live delegation: the agent acting for Ada, who
  // holds privacy:manage, is refused every one on the agent prefix.
  const bodies: Readonly<Record<Name, Readonly<Record<string, unknown>>>> = {
    'legal.draft_version': draftBody(),
    'legal.approve_version': {
      operationId: randomUUID(),
      versionId: alphaId,
      digest: digestOf(alphaDraft.body),
    },
    'legal.publish_version': { operationId: randomUUID(), versionId: alphaId },
  };
  for (const name of NAMES) {
    // oxlint-disable-next-line no-await-in-loop
    const agent = await call(harness.world.api, agentPath('alpha', pathOf(name)), bodies[name], {
      ...bearer(harness.world.agent.token),
      [DELEGATION_HEADER]: credential,
    });
    expect({ status: agent.status, code: agent.code }, name).toEqual({
      status: 403,
      code: 'DELEGATION_EXCLUDES_OPERATION',
    });
  }

  expect(await versionRows(harness.world.alpha)).toEqual(alphaCount);
  const alphaShown = await readPublic('alpha', 'data-handling');
  expect(alphaShown.text).not.toContain(bravo.body.body);
  expect(bravoShown.text).not.toContain(alphaDraft.body);
}

describe.skipIf(serverUrl === undefined)('C81 the legal documents', () => {
  it(
    'C81 exact-version approval: only the version the owner approved, with the bytes they read, publishes',
    c81ExactVersionApprovalOnlyTheVersion,
  );
});
describe.skipIf(serverUrl === undefined)('C81 the legal documents', () => {
  it('C81 exact-version approval: a malformed draft or approval is refused and nothing is written', async () => {
    const before = await versionRows(harness.world.alpha);
    const cases: ReadonlyArray<readonly [Readonly<Record<string, unknown>>, string]> = [
      [draftBody({ document: 'hire-agreement' }), 'document'],
      [draftBody({ document: 7 }), 'document'],
      [draftBody({ version: 'one' }), 'version'],
      [draftBody({ version: '1.2.3' }), 'version'],
      [draftBody({ body: '' }), 'body'],
      [draftBody({ body: '   ' }), 'body'],
      [draftBody({ body: 'x'.repeat(200_001) }), 'body'],
    ];
    for (const [body, field] of cases) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await draft(body);
      expect({ status: answer.status, code: answer.code }, field).toEqual({
        status: 422,
        code: 'FIELD_VALUE_INVALID',
      });
      expect(JSON.stringify(answer.body), field).toContain(field);
    }
    const drafted = await draft();
    const versionId = detailOf(drafted)['versionId'];
    for (const digest of ['', 'A'.repeat(64), 'not hex', 42]) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await approve(versionId, digest);
      expect(answer.code, String(digest)).toBe('FIELD_VALUE_INVALID');
    }
    // A made-up version and a malformed one are the same answer.
    for (const id of [randomUUID(), 'not-a-uuid']) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await publish(id);
      expect({ status: answer.status, code: answer.code }, id).toEqual({
        status: 404,
        code: 'NOT_FOUND',
      });
    }
    // An undeclared field is refused at the boundary.
    const undeclared = await draft(draftBody({ publishedAt: new Date().toISOString() }));
    expect({ status: undeclared.status, code: undeclared.code }).toEqual({
      status: 400,
      code: 'COMMAND_BODY_INVALID',
    });
    const after = await versionRows(harness.world.alpha);
    expect(after[0]?.n).toBe((before[0]?.n ?? 0) + 1);
    expect(after[0]?.approved).toBe(before[0]?.approved);
  });
});
describe.skipIf(serverUrl === undefined)('C81 the legal documents', () => {
  it(
    'C81 published version unchanged: an in-place edit is refused and the published bytes read back unchanged',
    c81PublishedVersionUnchangedAnInPlace,
  );

  it(
    'C81 isolation: another business, another client and a delegated agent never read, count or change a version',
    c81IsolationAnotherBusinessAnotherClientAnd,
  );
});
