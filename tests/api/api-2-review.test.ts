// SPDX-License-Identifier: AGPL-3.0-only
//
// API-2 interim review (SL09-API2-1): proofs for the agent credential on the
// agent route. Each case fails on ca9bd2dbd and names the defect it holds shut.
// Helpers: `api-2-agent-credential-world.ts`, `-use-world.ts`.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { SecuritySignal } from '../../apps/api/alerts/detect.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { bearer, serverUrl, type Answer } from '../acceptance/world.ts';
import { harness, issueBody, openWorld, revoke } from './api-2-agent-credential-world.ts';
import {
  agentComments,
  apiWith,
  asCredential,
  comment,
  issued,
  latch,
} from './api-2-agent-credential-use-world.ts';

openWorld();

const needsServer = it.skipIf(serverUrl === undefined);
const WIDE = { credential: 1000, person: 1000, business: 1000 };
const madeUpCredential = (): string => randomBytes(32).toString('base64url');
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Audit events whose actor is this credential's agent, any command, any outcome. */
async function agentEvents(credentialId: string): Promise<number> {
  const rows = await harness.world.db.admin.execute<{ readonly n: string }>(
    `select count(*)::text as n from public.audit_events e
       join public.agent_credentials c
         on c.business_id = e.business_id and c.agent_actor_id = e.actor_id
      where c.id = $1`,
    [credentialId],
  );
  return Number(rows[0]?.n ?? '-1');
}

/** Refused rows in alpha's authentication-attempt trail (I13), as one text and a count. */
async function refusedAttempts(): Promise<{ readonly n: number; readonly text: string }> {
  const rows = await harness.world.db.admin.execute<{ readonly row: string }>(
    `select to_jsonb(a)::text as row from public.authentication_attempts a
      where a.business_id = $1 and a.outcome = 'refused'`,
    [harness.world.alpha],
  );
  return { n: rows.length, text: rows.map((one) => one.row).join('\n') };
}

needsServer(
  'API-2 review key enumeration: a credential-form bearer on the agent route cannot tell a business key that exists from one nobody holds',
  async () => {
    const read = { recordId: harness.alphaTask.id };
    const api = harness.world.api;
    const alphas = await issued();
    const pairs = await Promise.all(
      [madeUpCredential(), alphas.secret].map(
        async (secret) =>
          await Promise.all(
            ['bravo', 'zulu-not-a-business'].map(
              async (key) => await asCredential('task.read', read, bearer(secret), api, key),
            ),
          ),
      ),
    );
    for (const [known, unknown] of pairs) {
      expect(known?.status, 'the same status').toBe(unknown?.status);
      expect(known?.text, 'the same bytes').toBe(unknown?.text);
    }
  },
);

needsServer(
  'API-2 review quota outside reach: calls outside the credential’s reach count against its request limit, so a burst of them is refused and stops writing',
  async () => {
    const api = apiWith({
      agentCredentials: {
        limits: {
          requests: { ...WIDE, credential: 2 },
          concurrent: WIDE,
          exports: WIDE,
          refused: 1000,
        },
      },
    });
    const credential = await issued();
    const before = await agentEvents(credential.id);
    const answers: Answer[] = [];
    const outside = async (): Promise<Answer> =>
      await asCredential('credential.issue', issueBody(), bearer(credential.secret), api);
    for (let n = 0; n < 4; n += 1) {
      // One after another, so the count is the limit's and not a race's.
      // oxlint-disable-next-line no-await-in-loop
      answers.push(await outside());
    }
    const codes = answers.map((answer) => answer.code);
    expect(
      codes.filter((code) => code === 'AGENT_QUOTA_EXCEEDED'),
      codes.join(','),
    ).toHaveLength(2);
    expect(
      (await agentEvents(credential.id)) - before,
      'audit rows past the limit',
    ).toBeLessThanOrEqual(2);
  },
);

needsServer(
  'API-2 review retry counts once: a lost-response retry that loses the identity race and is retried by retryOnce counts as one request',
  async () => {
    // Two connections for the two calls, and a third holding the task row.
    const pool = connect(harness.world.db.appUrl, { source: 'runtime', max: 3 });
    const api = apiWith({
      database: pool,
      agentCredentials: {
        limits: {
          requests: { ...WIDE, credential: 3 },
          concurrent: WIDE,
          exports: WIDE,
          refused: 1000,
        },
      },
    });
    const credential = await issued();
    const recordId = harness.alphaTask.id;
    const revision = await harness.world.db.admin.execute<{ readonly revision: string }>(
      'select revision::text as revision from public.records where id = $1',
      [recordId],
    );
    // One operation sent twice, as an agent resends after a lost response.
    const body = {
      operationId: randomUUID(),
      recordId,
      expectedRevision: Number(revision[0]?.revision ?? '0'),
      body: `sent twice ${randomUUID()}`,
      audience: 'internal',
    };
    const hold = latch();
    const locked = latch();
    const own = connect(harness.world.db.appUrl, { source: 'runtime', max: 1 });
    const holding = own.withBusiness(harness.world.alpha, async (tx) => {
      await tx.query('select id from public.records where id = $1 for update', [recordId]);
      locked.open();
      await hold.promise;
    });
    await locked.promise;
    // Both read no register row, then wait on the task; the loser's register
    // insert meets the winner's committed row and retryOnce runs it again.
    const first = asCredential('task.comment', body, bearer(credential.secret), api);
    const second = asCredential('task.comment', body, bearer(credential.secret), api);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1000);
    });
    hold.open();
    await holding.finally(async () => await own.close());
    const both = await Promise.all([first, second]);
    expect(both.map((answer) => answer.code)).toEqual(['ok', 'ok']);
    expect(await agentComments(credential.id), 'applied once, replayed once').toBe(1);
    // Two requests of three: the third is inside the limit.
    const third = await asCredential('task.read', { recordId }, bearer(credential.secret), api);
    await pool.close();
    expect(third.code, 'two requests counted as two').toBe('ok');
  },
);

needsServer(
  'API-2 review attempts recorded: a revoked or made-up credential turned away at the agent route leaves an authentication-attempt row, holding no secret',
  async () => {
    const credential = await issued();
    expect((await revoke(credential.id)).code).toBe('ok');
    const madeUp = madeUpCredential();
    const before = await refusedAttempts();
    expect((await comment(bearer(credential.secret))).code).toBe('DELEGATION_NOT_LIVE');
    expect((await comment(bearer(madeUp))).code).toBe('DELEGATION_NOT_LIVE');
    const after = await refusedAttempts();
    expect(after.n - before.n, 'one refused attempt per call').toBe(2);
    expect(after.text).not.toContain(credential.secret);
    expect(after.text).not.toContain(madeUp);
    // Each row read whole: owned by the delegation, the digest of the digest, nothing of the caller's.
    for (const secret of [credential.secret, madeUp]) {
      // oxlint-disable-next-line no-await-in-loop
      const rows = await harness.world.db.admin.execute<Record<string, unknown>>(
        `select owner, provider, outcome, refusal_code, login_id, actor_id, person_id, session_id
           from public.authentication_attempts
          where business_id = $1 and subject_digest = $2`,
        [harness.world.alpha, sha(`agent-credential\u0000${sha(secret)}`)],
      );
      expect(rows, 'the attempt row').toStrictEqual([
        {
          owner: 'delegation',
          provider: 'agent-credential',
          outcome: 'refused',
          refusal_code: 'DELEGATION_NOT_LIVE',
          login_id: null,
          actor_id: null,
          person_id: null,
          session_id: null,
        },
      ]);
      // Not the stored credential hash either, so the trail cannot be joined to the row.
      // oxlint-disable-next-line no-await-in-loop
      const raw = await harness.world.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.authentication_attempts
          where subject_digest in ($1, $2)`,
        [sha(secret), secret],
      );
      expect(raw[0]?.n, 'rows holding the secret or its stored hash').toBe('0');
    }
  },
);

needsServer(
  'API-2 review alert subject: a credential’s security signal names a subject that is no slice of any stored credential hash, the same for one credential and apart for two',
  async () => {
    const signals: SecuritySignal[] = [];
    const api = apiWith({ observe: (signal) => signals.push(signal) });
    const [one, two] = [await issued(), await issued()];
    const read = { recordId: harness.alphaTask.id };
    for (const secret of [one.secret, one.secret, two.secret]) {
      // oxlint-disable-next-line no-await-in-loop
      expect((await asCredential('task.read', read, bearer(secret), api)).code).toBe('ok');
    }
    const subjects = signals.map((signal) => (signal.kind === 'export' ? signal.who : ''));
    expect(subjects, 'one export signal per read').toHaveLength(3);
    const hashes = await harness.world.db.admin.execute<{ readonly credential_hash: string }>(
      'select credential_hash from public.agent_credentials',
    );
    expect(hashes.length).toBeGreaterThan(1);
    for (const who of subjects) {
      const subject = who.slice(who.indexOf('\u0000') + 1);
      expect(who.startsWith('agent-credential\u0000'), who).toBe(true);
      expect(subject.length, 'a subject, not empty').toBeGreaterThanOrEqual(32);
      for (const { credential_hash: hash } of hashes) {
        expect(hash.startsWith(subject), 'the subject is a slice of a stored hash').toBe(false);
        expect(hash.includes(subject.slice(0, 16)), 'part of a stored hash').toBe(false);
      }
    }
    expect(subjects[0], 'one credential groups together').toBe(subjects[1]);
    expect(subjects[2], 'two credentials stay apart').not.toBe(subjects[0]);
  },
);
