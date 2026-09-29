// SPDX-License-Identifier: AGPL-3.0-only
//
// C81: the overseas-services register (SP-25) and the privacy policy that
// reads it. Each row of the register is set by `privacy.set_overseas_service`
// under `privacy:manage`, never an agent's, and every change is a tracked,
// audited operation. A privacy-policy version is drafted with the register as
// it stood (the rows in use and their digest, fixed on the version); approving
// or publishing it is refused while any of those rows is marked "to confirm",
// or once the register has changed since the draft. The public read of the
// policy carries the services beside the words.
//
// Ada is alpha's owner and holds `privacy:manage`; Noah holds `operations:read`
// alone; Mia holds neither; Bea is bravo's owner and holds `privacy:manage`
// there. A client of alpha holds a share and nothing else, and the agent acts
// under a live delegation from Ada. Every service below is made up.

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { approveLegalVersion } from '../../packages/core-records/src/operations/legal-documents.ts';
import { setOverseasService } from '../../packages/core-records/src/operations/overseas-services.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
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

const CANARY = 'CANARY-c81-register-to-confirm-5b91e2';

if (serverUrl === undefined) {
  console.warn('operations/c81-register: DATABASE_URL is unset, so nothing below ran.');
}

const SET = '/privacy/set_overseas_service';

const digestOf = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** A world caller as the fixture's member, which carries the same ids. */
const member = (caller: unknown) => caller as Member;

const detailOf = (answer: Answer) => (answer.body['detail'] ?? {}) as Record<string, unknown>;

/** A made-up version label no other case in this file uses. */
let minor = 0;
const nextVersion = () => `1.${String((minor += 1))}`;

/** A made-up register row, in use and confirmed unless overridden. */
const row = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  operationId: `c81r-${randomUUID()}`,
  service: `Made-up service ${randomUUID().slice(0, 8)}`,
  receives: 'recipient address and name',
  where: 'Japan and the United States',
  trainsOnIt: 'no',
  contract: 'the provider business terms',
  toConfirm: false,
  inUse: true,
  ...overrides,
});

/** The fields of a row as the public policy lists it. */
const listed = (sent: ReturnType<typeof row>) => ({
  service: sent.service,
  receives: sent.receives,
  where: sent.where,
  trainsOnIt: sent.trainsOnIt,
  contract: sent.contract,
});

describe.skipIf(serverUrl === undefined)('C81 the overseas-services register', () => {
  let harness: Harness;
  let credential: string;
  let clientToken: string;

  const set = async (
    body: Readonly<Record<string, unknown>>,
    token = harness.world.ada.token,
    businessKey = 'alpha',
  ) => await call(harness.world.api, personPath(businessKey, SET), body, bearer(token));

  /** Set a row and expect it applied. */
  const setOk = async (
    body: Readonly<Record<string, unknown>>,
    token = harness.world.ada.token,
    businessKey = 'alpha',
  ) => {
    const answer = await set(body, token, businessKey);
    expect(answer.status, 'set').toBe(200);
    return answer;
  };

  const draft = async (
    document = 'privacy-policy',
    token = harness.world.ada.token,
    businessKey = 'alpha',
  ) => {
    const body = `# ${document}\n\nMade-up text ${randomUUID()}.\n`;
    const answer = await call(
      harness.world.api,
      personPath(businessKey, '/legal/draft_version'),
      { operationId: `c81r-${randomUUID()}`, document, version: nextVersion(), body },
      bearer(token),
    );
    expect(answer.status, 'drafted').toBe(200);
    return { versionId: String(detailOf(answer)['versionId']), body };
  };

  const approve = async (
    drafted: { readonly versionId: string; readonly body: string },
    token = harness.world.ada.token,
    businessKey = 'alpha',
  ) =>
    await call(
      harness.world.api,
      personPath(businessKey, '/legal/approve_version'),
      {
        operationId: `c81r-${randomUUID()}`,
        versionId: drafted.versionId,
        digest: digestOf(drafted.body),
      },
      bearer(token),
    );

  const publish = async (
    versionId: string,
    token = harness.world.ada.token,
    businessKey = 'alpha',
  ) =>
    await call(
      harness.world.api,
      personPath(businessKey, '/legal/publish_version'),
      { operationId: `c81r-${randomUUID()}`, versionId },
      bearer(token),
    );

  /** Draft, approve and publish a privacy policy; answers what the public reads. */
  const releasePolicy = async (token = harness.world.ada.token, businessKey = 'alpha') => {
    const drafted = await draft('privacy-policy', token, businessKey);
    expect((await approve(drafted, token, businessKey)).status, 'approved').toBe(200);
    expect((await publish(drafted.versionId, token, businessKey)).status, 'published').toBe(200);
    return await readPolicy(businessKey);
  };

  const readPolicy = async (businessKey = 'alpha') => {
    const response = await harness.world.api.request(
      `/api/public/b/${businessKey}/legal/privacy-policy`,
    );
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> };
  };

  const registerRows = async (businessId: string) =>
    await harness.world.db.app.withBusiness(
      businessId,
      async (tx) =>
        await tx.query<{ readonly row: string }>(
          `select to_jsonb(s)::text as row from public.overseas_services s order by s.id`,
        ),
    );

  beforeAll(async () => {
    harness = await createHarness('c81_register');
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

  it('C81 register complete in the policy: a row added is in the next policy, and a row to confirm or a change since the draft leaves the policy not ready', async () => {
    const first = row();
    await setOk(first);
    const one = await releasePolicy();
    expect(one.json['services']).toEqual([listed(first)]);

    // A row added: the published policy is unchanged in place, and the next
    // version lists both, in the register's order.
    const added = row({ service: `${first.service} two`, where: 'Australia: Sydney' });
    await setOk(added);
    expect((await readPolicy()).json).toEqual(one.json);
    const two = await releasePolicy();
    expect(two.json['services']).toEqual([listed(first), listed(added)]);

    // A row marked "to confirm": a draft may be made to read, but it is not
    // ready, and the published version stays the one before.
    await setOk({ ...added, operationId: randomUUID(), toConfirm: true });
    const unconfirmed = await draft();
    const notReady = await approve(unconfirmed);
    expect({ status: notReady.status, code: notReady.code }).toEqual({
      status: 409,
      code: 'LEGAL_REGISTER_UNCONFIRMED',
    });
    expect((await readPolicy()).json).toEqual(two.json);
    // The other documents do not read the register.
    const terms = await draft('client-terms');
    expect((await approve(terms)).status).toBe(200);

    // Confirmed again: the draft made before is spent (the register changed
    // since), and a new draft is ready.
    await setOk({ ...added, operationId: randomUUID(), toConfirm: false });
    const stale = await approve(unconfirmed);
    expect({ status: stale.status, code: stale.code }).toEqual({
      status: 409,
      code: 'LEGAL_REGISTER_CHANGED',
    });

    // Approved, then the register changes before publication: not published.
    const approved = await draft();
    expect((await approve(approved)).status).toBe(200);
    const changed = row({ where: 'the United States' });
    await setOk(changed);
    const late = await publish(approved.versionId);
    expect({ status: late.status, code: late.code }).toEqual({
      status: 409,
      code: 'LEGAL_REGISTER_CHANGED',
    });
    expect((await readPolicy()).json).toEqual(two.json);

    // A service no longer in use leaves the next policy.
    await setOk({ ...changed, operationId: randomUUID(), inUse: false });
    const three = await releasePolicy();
    expect(three.json['services']).toEqual([listed(first), listed(added)]);

    // The register a version was drafted from is written once with it.
    for (const edit of [
      `update public.legal_document_versions set register = '[]'::jsonb where document = 'privacy-policy'`,
      `update public.legal_document_versions set register_digest = md5('x') where document = 'privacy-policy'`,
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      const refusal = await harness.world.db.app
        .withBusiness(harness.world.alpha, async (tx) => await tx.query(edit))
        .then(
          () => 'applied',
          (error: unknown) => String((error as { readonly code?: unknown }).code),
        );
      expect(refusal, edit).toBe('23001');
    }
    expect((await readPolicy()).json).toEqual(three.json);
  });

  it('C81 policy names what each service receives: no personal information to the model providers, the master Drive by public link, review media possibly overseas', async () => {
    const rows = [
      row({
        service: 'Model provider: Claude',
        receives: 'no personal information',
        where: 'overseas (United States)',
      }),
      row({
        service: 'Model provider: ChatGPT',
        receives: 'no personal information',
        where: 'overseas (United States)',
      }),
      row({
        service: 'Master Drive',
        receives:
          'client production files; each client folder is shared by public link, so anyone holding the link can open it',
        where: 'may be stored outside Australia',
      }),
      row({
        service: 'Cloudflare R2 (review media)',
        receives: 'review videos and other review media',
        where:
          'the Oceania region requested, not guaranteed to stay in Australia, so possibly overseas',
      }),
    ];
    for (const sent of rows) {
      // oxlint-disable-next-line no-await-in-loop
      await setOk(sent);
    }
    const policy = await releasePolicy();
    const services = policy.json['services'] as readonly Record<string, unknown>[];
    for (const sent of rows) {
      expect(services, sent.service).toContainEqual(listed(sent));
    }
    // Each is listed once, with its own words and nothing of another row's.
    expect(new Set(services.map((service) => service['service'])).size).toBe(services.length);
  });

  it('C81 register set: every change is tracked and audited, one row per service, and malformed input is refused by name with nothing written', async () => {
    const sent = row();
    const setOnce = await setOk(sent);
    const serviceId = detailOf(setOnce)['serviceId'];
    const again = await set({ ...sent, operationId: randomUUID(), receives: 'recipient address' });
    expect(detailOf(again)['serviceId']).toBe(serviceId);
    // The same service in other letter case is the same row.
    const cased = await set({
      ...sent,
      operationId: randomUUID(),
      service: sent.service.toUpperCase(),
    });
    expect(detailOf(cased)['serviceId']).toBe(serviceId);
    const audited = await harness.world.db.app.withBusiness(
      harness.world.alpha,
      async (tx) =>
        await tx.query<{ readonly n: number }>(
          `select count(*)::int as n from public.audit_events
          where command = 'privacy.set_overseas_service' and outcome = 'applied'
            and subject_record_id = $1`,
          [serviceId],
        ),
    );
    expect(audited[0]?.n).toBe(3);

    const before = await registerRows(harness.world.alpha);
    const cases: readonly (readonly [Readonly<Record<string, unknown>>, string])[] = [
      [row({ service: '' }), 'service'],
      [row({ service: 'x'.repeat(121) }), 'service'],
      [row({ service: 7 }), 'service'],
      [row({ receives: '   ' }), 'receives'],
      [row({ receives: 'x'.repeat(2001) }), 'receives'],
      [row({ where: undefined }), 'where'],
      [row({ trainsOnIt: '' }), 'trainsOnIt'],
      [row({ contract: [] }), 'contract'],
      [row({ toConfirm: 'yes' }), 'toConfirm'],
      [row({ inUse: undefined }), 'inUse'],
    ];
    for (const [body, field] of cases) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await set(body);
      expect({ status: answer.status, code: answer.code }, field).toEqual({
        status: 422,
        code: 'FIELD_VALUE_INVALID',
      });
      expect(JSON.stringify(answer.body), field).toContain(field);
    }
    for (const field of ['service', 'receives', 'where', 'trainsOnIt', 'contract']) {
      for (const bad of [`nul \u0000 ${CANARY}`, `lone \uD800 ${CANARY}`]) {
        // oxlint-disable-next-line no-await-in-loop
        const answer = await set(row({ [field]: bad }));
        expect({ status: answer.status, code: answer.code }, field).toEqual({
          status: 422,
          code: 'FIELD_VALUE_INVALID',
        });
        expect(JSON.stringify(answer.body)).not.toContain(CANARY);
      }
    }
    const undeclared = await set({ ...row(), region: 'Sydney' });
    expect({ status: undeclared.status, code: undeclared.code }).toEqual({
      status: 400,
      code: 'COMMAND_BODY_INVALID',
    });
    expect(await registerRows(harness.world.alpha)).toEqual(before);
  });

  it('C81 register change and approval at once: the approval waits for the change and is told the register changed', async () => {
    const drafted = await draft();
    const actorId = harness.world.ada.actorId as string;
    // Two connections, so the two transactions truly overlap: the first sets
    // a row and holds the register's lock for 300 ms before committing, and
    // the approval arrives meanwhile.
    const wide = connect(harness.world.db.appUrl, { source: 'runtime', max: 2 });
    const change = row();
    const first = wide.withBusiness(harness.world.alpha, async (tx) => {
      await setOverseasService(
        tx,
        {
          service: change.service,
          receives: change.receives,
          where: change.where,
          trainsOnIt: change.trainsOnIt,
          contract: change.contract,
          toConfirm: false,
          inUse: true,
        },
        actorId,
      );
      await tx.query('select pg_sleep(0.3)');
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    const second = wide.withBusiness(
      harness.world.alpha,
      async (tx) =>
        await approveLegalVersion(tx, drafted.versionId, digestOf(drafted.body), actorId),
    );
    const outcomes = await Promise.allSettled([first, second]).finally(
      async () => await wide.close(),
    );
    expect(outcomes).toEqual([
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: 'register-changed' },
    ]);
  });

  it('C81 refusal privacy:manage: a holder of operations:read alone, a member and a client are refused the register, and nothing is written', async () => {
    const before = await registerRows(harness.world.alpha);
    for (const token of [harness.world.noah.token, harness.world.mia.token, clientToken]) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await set(row(), token);
      expect({ status: answer.status, code: answer.code }).toEqual({
        status: 403,
        code: 'SCOPE_NOT_GRANTED',
      });
    }
    expect(await registerRows(harness.world.alpha)).toEqual(before);
  });

  it('C81 isolation: another business, another client and a delegated agent never read or change the register', async () => {
    const alphaRow = row({ service: `alpha only ${randomUUID()}` });
    await setOk(alphaRow);
    const alphaBefore = await registerRows(harness.world.alpha);

    // Another business: bravo's register is bravo's; its rows never reach
    // alpha's policy, and alpha's never reach bravo's.
    const bravoRow = row({ service: `bravo only ${randomUUID()}` });
    await setOk(bravoRow, harness.world.bea.token, 'bravo');
    const bravoPolicy = await releasePolicy(harness.world.bea.token, 'bravo');
    expect(bravoPolicy.json['services']).toEqual([listed(bravoRow)]);
    // A draft of alpha's is not changed by bravo's register moving.
    const alphaDraft = await draft();
    await setOk(row(), harness.world.bea.token, 'bravo');
    expect((await approve(alphaDraft)).status).toBe(200);
    expect((await publish(alphaDraft.versionId)).status).toBe(200);
    const alphaPolicy = await readPolicy('alpha');
    expect(alphaPolicy.text).not.toContain(bravoRow.service);
    expect(bravoPolicy.text).not.toContain(alphaRow.service);

    // Bea on alpha's prefix is no member of alpha.
    const across = await set(row(), harness.world.bea.token, 'alpha');
    expect({ status: across.status, code: across.code }).toEqual({
      status: 403,
      code: 'AUTH_NO_MEMBERSHIP',
    });

    // Another client in the same business: a share does not reach it.
    const client = await set(
      { ...alphaRow, operationId: randomUUID(), receives: 'x' },
      clientToken,
    );
    expect(client.status).toBe(403);
    expect(JSON.stringify(client.body)).not.toContain(alphaRow.service);

    // Another person under a live delegation: the agent acting for Ada, who
    // holds privacy:manage, is refused on the agent prefix.
    const agent = await call(harness.world.api, agentPath('alpha', SET), row(), {
      ...bearer(harness.world.agent.token),
      [DELEGATION_HEADER]: credential,
    });
    expect({ status: agent.status, code: agent.code }).toEqual({
      status: 403,
      code: 'DELEGATION_EXCLUDES_OPERATION',
    });

    expect(await registerRows(harness.world.alpha)).toEqual(alphaBefore);
  });

  it('C81 isolation: a row still to confirm reaches no log, audit row, operation register row, refusal or public read', async () => {
    const logged: string[] = [];
    const capture = (...parts: unknown[]) => void logged.push(parts.map(String).join(' '));
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(capture),
    );
    const secret = row({ service: `service ${CANARY}`, receives: CANARY, toConfirm: true });
    try {
      await setOk(secret);
      const drafted = await draft();
      const answers = [
        await set(row({ receives: CANARY }), harness.world.mia.token),
        await set(row({ receives: CANARY }), harness.world.bea.token, 'alpha'),
        await approve(drafted),
        await publish(drafted.versionId),
      ];
      for (const answer of answers) {
        expect(answer.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(answer.body)).not.toContain(CANARY);
      }
      for (const key of ['alpha', 'bravo']) {
        // oxlint-disable-next-line no-await-in-loop
        expect((await readPolicy(key)).text).not.toContain(CANARY);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
      // Leave the register confirmed for any case after this one.
      await set({ ...secret, operationId: randomUUID(), inUse: false });
    }
    expect(logged.join('\n')).not.toContain(CANARY);

    const stored = await harness.world.db.app.withBusiness(
      harness.world.alpha,
      async (tx) =>
        await tx.query<{ readonly row: string }>(
          `select to_jsonb(e)::text as row from public.audit_events e
          where command in ('privacy.set_overseas_service', 'legal.draft_version')
         union all
         select to_jsonb(o)::text from public.operations o
          where command in ('privacy.set_overseas_service', 'legal.draft_version')`,
        ),
    );
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.map((found) => found.row).join('\n')).not.toContain(CANARY);
  });
});
