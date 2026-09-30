// SPDX-License-Identifier: AGPL-3.0-only
//
// API-2: the agent credential in use, on the agent route, through the real
// API. The credential is the bearer and the whole of the sign-in: the
// product's own scheme, never the provider's verifier and never a cookie. Its
// calls run as the agent actor for the person who issued it, inside the scope
// they ticked and their grants as they are now, and revocation and expiry are
// read on every call. Issuing and revoking are proved in
// `api-2-agent-credential.test.ts` and `-revoke.test.ts`; the quota in
// `-quota.test.ts`. Helpers: `api-2-agent-credential-use-world.ts`.

import { randomBytes } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import {
  lockAgentCredential,
  revokeAgentCredential,
} from '../../packages/core-records/src/index.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { pathOf } from '../../packages/core-wire/src/index.ts';
import { grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import { testSignIn } from '../support/sign-in.ts';
import {
  ACCEPTANCE_ISSUER,
  bearer,
  call,
  personPath,
  serverUrl,
  type Answer,
} from '../acceptance/world.ts';
import {
  CANARY,
  DAY_MS,
  harness,
  issueBody,
  openWorld,
  revoke,
} from './api-2-agent-credential-world.ts';
import {
  agentComments,
  apiWith,
  asCredential,
  comment,
  consoleDuring,
  cookieOf,
  hs256,
  issued,
  latch,
  wordsOf,
} from './api-2-agent-credential-use-world.ts';

openWorld();

const needsServer = it.skipIf(serverUrl === undefined);
const madeUpCredential = (): string => randomBytes(32).toString('base64url');

beforeAll(async () => {
  if (serverUrl === undefined) return;
  // Noah may comment too, so his credential can carry it and the actor and
  // person case is a person who is not the owner.
  await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
    const noah = harness.world.noah as unknown as Member;
    await grantTo(tx, noah, 'comment', WHOLE_BUSINESS, false, 'task');
  });
});

needsServer(
  "API-2 revocation next call: a revoked credential's next command is refused in plain words, with no secret in the refusal",
  async () => {
    const credential = await issued();
    expect((await comment(bearer(credential.secret))).code, 'while it lives').toBe('ok');
    expect((await revoke(credential.id)).code).toBe('ok');

    const refused = await comment(bearer(credential.secret));
    expect(refused.status).toBe(401);
    expect(refused.code).toBe('DELEGATION_NOT_LIVE');
    expect(wordsOf(refused)).toMatch(/revoked/iu);
    expect(refused.text).not.toContain(credential.secret);
    expect(await agentComments(credential.id), 'the refused call wrote nothing').toBe(1);
  },
);

needsServer(
  'API-2 revocation under the lock: a call behind an open revocation waits for it and is refused',
  async () => {
    const credential = await issued();
    const wide = connect(harness.world.db.appUrl, { source: 'runtime', max: 1 });
    const hold = latch();
    const locked = latch();
    const revocation = wide.withBusiness(harness.world.alpha, async (tx) => {
      const held = await lockAgentCredential(tx, credential.id);
      if (held === undefined) throw new Error('the credential is not there');
      await revokeAgentCredential(tx, held, harness.world.ada.actorId as string);
      locked.open();
      await hold.promise;
    });
    await locked.promise;
    const behind = comment(bearer(credential.secret));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 300);
    });
    hold.open();
    await revocation.finally(async () => await wide.close());
    expect((await behind).code).toBe('DELEGATION_NOT_LIVE');
    expect(await agentComments(credential.id)).toBe(0);
  },
);

needsServer(
  'API-2 expiry on the agent route: a credential used one second before its expiry is accepted and one second after is refused in plain words, with no secret in the refusal or the logs',
  async () => {
    const expiresAt = new Date(Math.floor((Date.now() + 2 * DAY_MS) / 1000) * 1000);
    const credential = await issued({
      expiresAt: expiresAt.toISOString(),
      purpose: `${CANARY} the expiry case`,
    });
    let clock = new Date(expiresAt.getTime() - 1000);
    const api = apiWith({ agentCredentials: { now: () => clock } });
    expect((await comment(bearer(credential.secret), api)).code, 'one second before').toBe('ok');

    clock = new Date(expiresAt.getTime() + 1000);
    let after: Answer = { status: 0, body: {}, code: '', text: '' };
    const logged = await consoleDuring(async () => {
      after = await comment(bearer(credential.secret), api);
    });
    expect(after.status).toBe(401);
    expect(after.code).toBe('DELEGATION_NOT_LIVE');
    expect(wordsOf(after)).toMatch(/expired/iu);
    for (const secret of [credential.secret, CANARY]) {
      expect(after.text).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }
    expect(await agentComments(credential.id)).toBe(1);
  },
);

needsServer(
  'API-2 actor and person: every command made with the credential records the agent as actor and the person it acts for',
  async () => {
    const credential = await issued({}, harness.world.noah.token);
    expect((await comment(bearer(credential.secret))).code).toBe('ok');
    const rows = await harness.world.db.admin.execute<{
      readonly actor_id: string;
      readonly kind: string;
      readonly person_id: string;
      readonly register_actor: string;
    }>(
      `select e.actor_id, a.kind, c.issued_by_person_id as person_id, o.actor_id as register_actor
         from public.audit_events e
         join public.actors a on a.business_id = e.business_id and a.id = e.actor_id
         join public.agent_credentials c
           on c.business_id = e.business_id and c.agent_actor_id = e.actor_id
         join public.operations o
           on o.business_id = e.business_id and o.operation_id = e.operation_id
          and o.actor_id = e.actor_id
        where c.id = $1 and e.command = 'task.comment'`,
      [credential.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('agent');
    expect(rows[0]?.actor_id).not.toBe(harness.world.noah.actorId);
    expect(rows[0]?.register_actor).toBe(rows[0]?.actor_id);
    expect(rows[0]?.person_id).toBe(harness.world.noah.personId);
  },
);

needsServer(
  "API-2 own scheme: the credential is verified by the product's own scheme and never by the sign-in provider's legacy signing secret",
  async () => {
    const credential = await issued();
    let asked = 0;
    const provider = createSupabaseVerifier(testSignIn(ACCEPTANCE_ISSUER));
    const verify: typeof provider = async (request) => {
      asked += 1;
      return await provider(request);
    };
    const api = apiWith({ verify });
    expect((await comment(bearer(credential.secret), api)).code).toBe('ok');
    expect(asked, 'the provider verifier never sees the credential').toBe(0);

    // Signed with a shared secret and naming the issuing person, as the
    // removed legacy scheme minted: refused, and nothing written.
    const exp = Math.floor(Date.now() / 1000) + 600;
    const claims = { sub: harness.world.ada.subject, aud: 'authenticated', exp };
    const legacy = await comment(bearer(hs256(claims, credential.secret)), api);
    expect(legacy.status).toBe(401);

    // A made-up credential and a revoked one answer the same bytes.
    const madeUp = await comment(bearer(madeUpCredential()), api);
    expect((await revoke(credential.id)).code).toBe('ok');
    const spent = await comment(bearer(credential.secret), api);
    expect(madeUp.status).toBe(401);
    expect(madeUp.text).toBe(spent.text);
    expect(await agentComments(credential.id)).toBe(1);
  },
);

needsServer(
  'API-2 bearer only: the credential is accepted only as a bearer token on the agent route, never as or in place of the browser session cookie, and the cookie is refused on the agent route',
  async () => {
    const credential = await issued();
    const read = { recordId: harness.alphaTask.id };
    const onPerson = async (headers: Record<string, string>): Promise<Answer> =>
      await call(harness.world.api, personPath('alpha', pathOf('task.read')), read, headers);

    // The credential in the browser's cookie on either route, or as a
    // bearer on the person route: never a sign-in.
    expect((await comment(cookieOf(credential.secret))).status).toBe(401);
    expect((await onPerson(cookieOf(credential.secret))).status).toBe(401);
    expect((await onPerson(bearer(credential.secret))).status).toBe(401);
    expect(await agentComments(credential.id)).toBe(0);

    // A session cookie on the agent route is refused, even one holding a
    // token that is good there as a bearer.
    const agentToken = harness.world.agent.token;
    expect((await asCredential('task.queue', {}, bearer(agentToken))).code).toBe('ok');
    const agentCookie = await asCredential('task.queue', {}, cookieOf(agentToken));
    expect(agentCookie.status).toBe(401);
    expect(agentCookie.code).toBe('AUTH_UNKNOWN_LOGIN');

    // The control: the same credential as the bearer, on the agent route.
    expect((await comment(bearer(credential.secret))).code).toBe('ok');
  },
);

needsServer(
  'API-2 scope at use: a call outside the ticked keys is refused though the person holds it, and a person-only command is never the agent’s',
  async () => {
    const readOnly = await issued({ scope: [{ collection: 'task', action: 'read' }] });
    const headers = bearer(readOnly.secret);
    const read = await asCredential('task.read', { recordId: harness.alphaTask.id }, headers);
    expect(read.code, 'inside its scope').toBe('ok');
    const outside = await comment(headers);
    expect(outside.status).toBe(403);
    expect(outside.code).toBe('SCOPE_NOT_GRANTED');
    const personOnly = await asCredential('credential.issue', issueBody(), headers);
    expect(personOnly.status).toBe(403);
    expect(personOnly.code).toBe('DELEGATION_EXCLUDES_OPERATION');
    expect(await agentComments(readOnly.id)).toBe(0);
  },
);

needsServer(
  'API-2 isolation on use: another business’s key and another business’s task are not reached, and say nothing of either',
  async () => {
    const credential = await issued();
    const elsewhere = await comment(bearer(credential.secret), harness.world.api, 'bravo');
    const madeUp = await comment(bearer(madeUpCredential()), harness.world.api, 'bravo');
    expect(elsewhere.status).toBe(401);
    expect(elsewhere.text).toBe(madeUp.text);
    const foreignRead = { recordId: harness.bravoRecordId };
    const foreign = await asCredential('task.read', foreignRead, bearer(credential.secret));
    expect(foreign.code).toBe('NOT_FOUND');
    expect(foreign.text).not.toContain(harness.bravoRecordId);
    expect(await agentComments(credential.id)).toBe(0);
  },
);
