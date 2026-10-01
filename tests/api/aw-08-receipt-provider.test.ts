// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08 (b) through the real worker and API, the provider injected as T3e1's
// cases inject it:
//
// - `AW-08 receipt link`: the link the provider answers with is captured when
//   the effect is observed and kept only when it is https on the operation's
//   declared host; any other is recorded absent (null) and never a link.
// - `AW-08 hostile provider`: an oversized, redirected or malformed answer
//   moves no money (the whole hold stays held as unknown, nothing spent or
//   released) and marks nothing live (no effect, no observation, no link).
// - `AW-08 canary`: a planted credential and planted provider content reach no
//   row, audit payload, log or refusal body.

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { readIdentity } from '../../apps/api/identity.ts';
import type { Transport } from '../../apps/cli/client.ts';
import { createWorker } from '../../apps/worker/worker.ts';
import { SYNTHETIC_USAGE, type Provider } from '../../apps/worker/usage.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
const ROOT = resolve(import.meta.dirname, '../..');
const HOST = 'receipts.stand-in.invalid';
type Name = Parameters<typeof pathOf>[0];

const answering = (status: number, body: string): Provider => ({
  call: async () => await Promise.resolve({ status, body }),
});
const linking = (link: unknown): Provider => answering(200, JSON.stringify({ link }));

describe.skipIf(serverUrl === undefined)(
  'AW-08 receipt link and provider',
  { timeout: 60_000 },
  () => {
    let fixture: ApiFixture;
    let api: Hono;
    let personToken: string;
    let agentToken: string;

    const transport: Transport = async (path, body, bearer, delegation) =>
      await api.request(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...authorised(bearer),
          ...(delegation === undefined ? {} : { 'x-agent-delegation': delegation }),
        },
        body,
      });

    const asPerson = async (name: Name, body: object): Promise<Answer> =>
      await post(api, `/api/b/${BUSINESS_KEY}${pathOf(name)}`, body, authorised(personToken));

    /** A task with the synthetic change proposed by the worker and launched by the person. */
    async function launched(): Promise<{ taskId: string; credential: string }> {
      const created = await asPerson('task.create', {
        operationId: randomUUID(),
        fields: { title: `aw08 receipt ${randomUUID()}` },
      });
      const taskId = String(created.body['recordId']);
      const credential = await fixture.db.app.withBusiness(fixture.business, async (tx) => {
        const minted = await mintDelegation(tx, {
          agentActorId: fixture.agentActorId,
          delegatePersonId: fixture.member.personId,
          mintedByActorId: fixture.member.actorId,
          purpose: `aw08_${randomUUID().slice(0, 8)}`,
          collections: ['task'],
          actions: ['read', 'comment', 'write'],
          purposeScope: { kind: 'record', id: taskId },
          expiresAt: new Date(Date.now() + 3_600_000),
        });
        if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
        return minted.value.credential;
      });
      const proposed = await workerOn(credential).proposeOnce();
      if (!('proposed' in proposed)) throw new Error(`propose: ${JSON.stringify(proposed)}`);
      const read = await asPerson('task.read', { recordId: taskId });
      const task = read.body['task'] as { proposals: { versions: { versionId: string }[] }[] };
      const decided = await asPerson('task.decide', {
        operationId: randomUUID(),
        gateId: proposed.proposed.gateId,
        versionId: String(task.proposals[0]?.versions[0]?.versionId),
        decision: 'approve',
        note: 'launch this reviewed output',
      });
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
      return { taskId, credential };
    }

    const workerOn = (credential: string, provider?: Provider) =>
      createWorker({
        transport,
        businessKey: BUSINESS_KEY,
        credential: agentToken,
        delegation: credential,
        reporter: SYNTHETIC_USAGE,
        ...(provider === undefined ? {} : { provider }),
      });

    /** The task's attempts: their state, markers, the receipt link and the hold. */
    const attempts = async (taskId: string) =>
      await fixture.db.admin.execute<Record<string, unknown>>(
        `select att.id, att.state, att.observed, att.receipt_link as link, res.state as held,
              res.held_minor::text as held_minor, att.actual_minor
         from public.attempts att
         join public.reservations res on res.business_id = att.business_id and res.id = att.reservation_id
         join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
        where att.business_id = $1 and run.task_id = $2 order by att.created_at, att.id`,
        [fixture.business, taskId],
      );

    /** Launch, apply once with `provider`, and read the receipt as the person. */
    async function appliedWith(provider: Provider) {
      const { taskId, credential } = await launched();
      const outcome = await workerOn(credential, provider).applyOnce(taskId);
      if (!('applied' in outcome)) throw new Error(`apply: ${JSON.stringify(outcome)}`);
      const receipt = await asPerson('task.receipt', { attemptId: outcome.applied.attemptId });
      expect(receipt.status, JSON.stringify(receipt.body)).toBe(200);
      return { taskId, receipt: receipt.body['receipt'] as Record<string, unknown> };
    }

    beforeAll(async () => {
      fixture = await createApiFixture('aw08rcpt');
      api = fixture.compose(undefined, readIdentity(ROOT));
      personToken = await tokenFor(fixture.member.presented.subject);
      agentToken = await tokenFor(fixture.agent.subject);
      await fixture.db.admin.execute(
        'update public.budget_caps set limit_minor = 1000000000 where business_id = $1',
        [fixture.business],
      );
    }, 120_000);

    // One live delegation per purpose: each case retires the worker's pickup delegation.
    afterEach(async () => {
      await fixture.db.admin.execute(
        `update public.delegations set revoked_at = now(), revocation_cause = 'work_retired'
        where business_id = $1 and agent_actor_id = $2 and purpose = 'synthetic_comment'
          and revoked_at is null and settled_at is null`,
        [fixture.business, fixture.agentActorId],
      );
    });

    afterAll(async () => {
      await fixture?.db.drop();
    });

    it('AW-08 receipt link: an https link on the operation’s declared host is kept on the receipt with its decision, version and settlement', async () => {
      const link = `https://${HOST}/effects/${randomUUID()}`;
      const { taskId, receipt } = await appliedWith(linking(link));
      expect(receipt).toMatchObject({
        link,
        decision: { decidedByPersonId: fixture.member.personId },
        version: { number: 1 },
        settlement: { state: 'settled' },
      });
      expect(await attempts(taskId)).toMatchObject([{ observed: true, link }]);
    });

    it.each([
      ['plain http', `http://${HOST}/effects/1`],
      ['another host', 'https://receipts.example.com/effects/1'],
      ['a host that ends in the declared one', `https://evil${HOST}/effects/1`],
      ['the declared host as a prefix', `https://${HOST}.evil.example/effects/1`],
      ['a user before the host', `https://${HOST}@evil.example/effects/1`],
      ['a port', `https://${HOST}:8443/effects/1`],
      ['a query', `https://${HOST}/effects/1?token=t`],
      ['a fragment', `https://${HOST}/effects/1#t`],
      ['upper-case scheme', `HTTPS://${HOST}/effects/1`],
      ['a tab inside', `https://${HOST}/eff\tects/1`],
      ['backslashes', `https:\\\\${HOST}\\effects\\1`],
      ['a script', 'javascript:alert(1)'],
      ['no link', undefined],
      ['a number', 42],
      ['an overlong path', `https://${HOST}/${'a'.repeat(600)}`],
    ] as const)(
      'AW-08 receipt link: %s is recorded absent and never a link',
      async (_case, link) => {
        const { taskId, receipt } = await appliedWith(linking(link));
        expect(receipt['link']).toBeNull();
        expect(await attempts(taskId)).toMatchObject([{ observed: true, link: null }]);
      },
    );

    it.each([
      [
        'oversized',
        answering(200, JSON.stringify({ link: `https://${HOST}/x`, pad: 'x'.repeat(5_000) })),
      ],
      ['redirected', answering(302, JSON.stringify({ link: `https://${HOST}/x` }))],
      ['malformed', answering(200, '{"link": "https://receipts.stand-in.invalid/x"')],
      ['not an object', answering(200, JSON.stringify([`https://${HOST}/x`]))],
    ] as const)(
      'AW-08 hostile provider: a %s answer moves no money and marks nothing live',
      async (_case, provider) => {
        const { taskId, credential } = await launched();
        const outcome = await workerOn(credential, provider).applyOnce(taskId);
        expect(outcome).toStrictEqual({ dropped: { taskId, cause: 'provider_unavailable' } });
        expect(await attempts(taskId)).toMatchObject([
          {
            state: 'liability_unknown',
            observed: false,
            link: null,
            held: 'held',
            held_minor: '2500',
            actual_minor: null,
          },
        ]);
        const effects = await fixture.db.admin.execute(
          `select 1 from public.operations where business_id = $1 and record_id = $2
          and command = 'task.comment' and outcome = 'applied'`,
          [fixture.business, taskId],
        );
        expect(effects).toHaveLength(0);
      },
    );

    it('AW-08 canary: a planted credential and planted provider content reach no row, audit payload, log or refusal body', async () => {
      const planted = `aw08-planted-${randomUUID()}`;
      const output: string[] = [];
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          output.push(args.map(String).join(' '));
        }),
      );
      try {
        const kept = await appliedWith(
          answering(
            200,
            JSON.stringify({
              link: `https://evil.example/${planted}/${agentToken}`,
              note: planted,
            }),
          ),
        );
        expect(kept.receipt['link']).toBeNull();
        const { taskId, credential } = await launched();
        const hostile = await workerOn(
          credential,
          answering(
            302,
            JSON.stringify({ link: `https://${HOST}/${planted}`, secret: credential }),
          ),
        ).applyOnce(taskId);
        const [dump] = await fixture.db.admin.execute<{ dump: string }>(
          `select coalesce(string_agg(t, ' '), '') as dump from (
           select row_to_json(a)::text as t from public.attempts a where a.business_id = $1
           union all select row_to_json(o)::text from public.operations o where o.business_id = $1
           union all select row_to_json(e)::text from public.audit_events e where e.business_id = $1
           union all select row_to_json(r)::text from public.records r where r.business_id = $1) rows`,
          [fixture.business],
        );
        for (const secret of [planted, agentToken, credential]) {
          expect(dump?.dump ?? '').not.toContain(secret);
          expect(JSON.stringify(hostile)).not.toContain(secret);
          expect(JSON.stringify(kept)).not.toContain(secret);
          expect(output.join('\n')).not.toContain(secret);
        }
        // Not vacuous: the dump holds this business's attempts and their tasks.
        expect(dump?.dump ?? '').toContain(taskId);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });
  },
);
