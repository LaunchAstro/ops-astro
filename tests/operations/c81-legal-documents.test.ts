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

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/surface.ts';
import { tokenFor } from '../acceptance/cast.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import {
  agentPath,
  bearer,
  call,
  personPath,
  serverUrl,
  type Answer,
} from '../acceptance/world.ts';
import { grantTo, shareWithClient, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';

const CANARY = 'CANARY-c81-unpublished-draft-7e20c4';

if (serverUrl === undefined) {
  console.warn('operations/c81-legal-documents: DATABASE_URL is unset, so nothing below ran.');
}

type Name = 'legal.draft_version' | 'legal.approve_version' | 'legal.publish_version';
const NAMES: readonly Name[] = [
  'legal.draft_version',
  'legal.approve_version',
  'legal.publish_version',
];

/** The route of an operation, as `pathOf` in the surface builds it. */
const pathOf = (name: Name) => `/${name.replace('.', '/')}`;

/** The public address of a document's published version. */
const publicPath = (businessKey: string, document: string) =>
  `/api/public/b/${businessKey}/legal/${document}`;

const digestOf = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** A world caller as the fixture's member, which carries the same ids. */
const member = (caller: unknown) => caller as Member;

/** A made-up version label no other case in this file uses. */
let minor = 0;
const nextVersion = () => `1.${String((minor += 1))}`;

const draftBody = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  operationId: `c81-${randomUUID()}`,
  document: 'privacy-policy',
  version: nextVersion(),
  body: `# Privacy policy\n\nMade-up text ${randomUUID()}.\n`,
  ...overrides,
});

const detailOf = (answer: Answer) => (answer.body['detail'] ?? {}) as Record<string, unknown>;

describe.skipIf(serverUrl === undefined)('C81 the legal documents', () => {
  let harness: Harness;
  let credential: string;
  let clientToken: string;

  const as = async (
    token: string,
    name: Name,
    body: Readonly<Record<string, unknown>>,
    businessKey = 'alpha',
  ) => await call(harness.world.api, personPath(businessKey, pathOf(name)), body, bearer(token));

  const draft = async (
    body: Readonly<Record<string, unknown>> = draftBody(),
    token = harness.world.ada.token,
    businessKey = 'alpha',
  ) => await as(token, 'legal.draft_version', body, businessKey);

  const approve = async (
    versionId: unknown,
    digest: unknown,
    token = harness.world.ada.token,
    businessKey = 'alpha',
  ) =>
    await as(
      token,
      'legal.approve_version',
      { operationId: `c81-${randomUUID()}`, versionId, digest },
      businessKey,
    );

  const publish = async (
    versionId: unknown,
    token = harness.world.ada.token,
    businessKey = 'alpha',
  ) =>
    await as(
      token,
      'legal.publish_version',
      { operationId: `c81-${randomUUID()}`, versionId },
      businessKey,
    );

  /** Draft, approve and publish one version; answers its id and body. */
  const released = async (
    overrides: Readonly<Record<string, unknown>> = {},
    token = harness.world.ada.token,
    businessKey = 'alpha',
  ) => {
    const body = draftBody(overrides);
    const drafted = await draft(body, token, businessKey);
    expect(drafted.code, 'drafted').toBe('ok');
    const versionId = detailOf(drafted)['versionId'];
    expect((await approve(versionId, digestOf(String(body.body)), token, businessKey)).code).toBe(
      'ok',
    );
    expect((await publish(versionId, token, businessKey)).code, 'published').toBe('ok');
    return { versionId: String(versionId), body };
  };

  const readPublic = async (businessKey: string, document: string) => {
    const response = await harness.world.api.request(publicPath(businessKey, document));
    return { status: response.status, text: await response.text() };
  };

  const versionRows = async (businessId: string) =>
    await harness.world.db.app.withBusiness(businessId, async (tx) =>
      tx.query<{ readonly n: number; readonly approved: number; readonly published: number }>(
        `select count(*)::int as n, count(approved_at)::int as approved,
                count(published_at)::int as published
           from public.legal_document_versions`,
      ),
    );

  beforeAll(async () => {
    harness = await createHarness('c81_legal');
    const { world } = harness;
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await grantTo(tx, member(world.noah), 'read', WHOLE_BUSINESS, false, 'operations');
    });
    await world.db.app.withBusiness(world.bravo, async (tx) => {
      await grantTo(tx, member(world.bea), 'manage', WHOLE_BUSINESS, false, 'privacy');
    });
    const client = await shareWithClient(
      world.db.app,
      world.alpha,
      member(world.ada),
      harness.alphaTask.id,
    );
    clientToken = await tokenFor(client.presented.subject);

    const { decided } = await harness.approvedReservation();
    expect(decided.code, 'the decision a pickup needs').toBe('ok');
    const reservationId = (decided.body['detail'] as Record<string, unknown>)['reservationId'];
    const picked = await harness.asAgent('task.pickup', { reservationId });
    expect(picked.code, 'the pickup').toBe('ok');
    credential = String((picked.body['detail'] as Record<string, unknown>)['credential']);
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('C81 exact-version approval: only the version the owner approved, with the bytes they read, publishes', async () => {
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
    const events = await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) =>
      tx.query<{ readonly command: string; readonly outcome: string }>(
        `select command, outcome from public.audit_events
          where command like 'legal.%' and outcome = 'applied' order by seq`,
      ),
    );
    expect(new Set(events.map((event) => event.command))).toEqual(new Set(NAMES));
  });

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

  it('C81 published version unchanged: an in-place edit is refused and the published bytes read back unchanged', async () => {
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
  });

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

  it('C81 isolation: another business, another client and a delegated agent never read, count or change a version', async () => {
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
  });

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
