// SPDX-License-Identifier: AGPL-3.0-only
//
// C57 part C (#2119, spec #2085): `review.propose_change`, `review.decide_change` and
// `review.make_change_task` on the command line against the real served API, beside the same
// request on the person's HTTP route the app posts to. Each answers the same on both: a filing,
// a decision and the worker's task step store the same shape, and a second filing of a pin, a
// second decision and a repeated task step meet the same answer. A pin's client words are
// planted: a member with no proposal or review key (noah) is refused the filing, the decision
// and the review read with the same code on both, and no refusal on either carries the words.
// bravo's person names alpha's request and is refused the same way, with nothing moved.
//
// Separations named: business to business (bea in bravo, by alpha's request id); person to
// person (noah, a member without the keys, beside ada who holds them); the task the worker
// makes stays under the review's task and its client, which the server derives (part B).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import type { Caller } from '../acceptance/cast.ts';
import { bindAboutPage, ABOUT_FILE } from '../site/party-site-fixture.ts';
import { runCli, serveApi, type ServedApi } from './cli-process-harness.ts';

const MARKER = `client-words-${randomUUID().slice(0, 8)}`;

type Body = Readonly<Record<string, unknown>>;
interface Answer {
  readonly code: unknown;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

const detail = (answer: Answer) => (answer.body['detail'] ?? {}) as Record<string, unknown>;
const filing = (commentId: string) => ({
  commentId,
  text: 'Move the heading above the photo',
});
const approve = (changeRequestId: unknown) => ({ changeRequestId, decision: 'approve' });

describe.skipIf(serverUrl === undefined)(
  'C57 change requests on the command line and the app route',
  () => {
    let world: World;
    let api: ServedApi | undefined;
    let scratch: string;
    let taskId: string;
    let revisionId: string;
    let reviewId: string;

    const env = (who: Caller, business = 'alpha') => ({
      OPS_ASTRO_API_URL: (api as ServedApi).origin,
      OPS_ASTRO_BUSINESS: business,
      OPS_ASTRO_TOKEN: who.token,
      OPS_ASTRO_TOKEN_FILE: join(scratch, `token-${randomUUID()}`),
      OPS_ASTRO_DELEGATION_FILE: join(scratch, `delegation-${randomUUID()}`),
    });

    const cli = async (name: string, body: Body, who: Caller, business = 'alpha') => {
      const run = await runCli([name, '--json', JSON.stringify(body)], env(who, business));
      const raw = `${run.stdout}\n${run.stderr}`;
      return { code: run.json?.['code'] ?? 'ok', body: run.json ?? {}, raw } satisfies Answer;
    };

    const http = async (name: string, body: Body, who: Caller, business = 'alpha') => {
      const path = name.replace('.', '/');
      const response = await fetch(`${(api as ServedApi).origin}/api/b/${business}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${who.token}` },
        body: JSON.stringify(
          name.endsWith('.read') ? body : { operationId: randomUUID(), ...body },
        ),
      });
      const raw = await response.text();
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return { code: parsed['code'] ?? 'ok', body: parsed, raw } satisfies Answer;
    };

    const ok = async (name: string, body: Body): Promise<Readonly<Record<string, unknown>>> => {
      const answer = await cli(name, body, world.ada);
      if (answer.code !== 'ok') throw new Error(`${name} refused ${String(answer.code)}`);
      return answer.body;
    };

    /** A client pin carrying the planted words on the review's revision. */
    const clientPin = async (): Promise<string> =>
      String(
        (
          (
            await ok('review.pin_comment', {
              revisionId,
              width: 1480,
              selector: [
                {
                  type: 'FragmentSelector',
                  conformsTo: 'http://www.w3.org/TR/media-frags/',
                  value: 'xywh=0,0,9,9',
                },
              ],
              body: `Can the heading sit higher? ${MARKER}`,
              audience: 'client',
            })
          )['detail'] as Body
        )['commentId'],
      );

    /** ada's own live lease on the review's task, as the matrix takes it (EX-01). */
    async function lease(): Promise<{ readonly leaseId: unknown; readonly fence: unknown }> {
      const read = await ok('task.read', { recordId: taskId });
      const proposed = await ok('task.propose', {
        recordId: taskId,
        expectedRevision: (read['task'] as { revision: number }).revision,
        purpose: `c57c_${randomUUID().slice(0, 8)}`,
        maximumMinor: 2_000,
        currency: 'AUD',
        payload: { change: 'a team-only comment' },
        step: { kind: 'synthetic_comment', payload: {} },
      });
      const gate = proposed['detail'] as Body;
      const approved = await ok('task.decide', {
        gateId: gate['gateId'],
        versionId: gate['versionId'],
        decision: 'approve',
        note: 'approved so the request can be made a task',
      });
      const { reservationId } = approved['detail'] as Body;
      const picked = (await ok('task.pickup', { reservationId }))['detail'] as Body;
      return { leaseId: picked['leaseId'], fence: picked['fence'] };
    }

    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), 'c57-cli-parity-'));
      world = await createWorld('c57_cli_parity');
      api = await serveApi(world);
      const task = await ok('task.create', { fields: { title: 'a page under review' } });
      taskId = String(task['recordId']);
      const client = await ok('client.create', { name: `C57 client ${randomUUID().slice(0, 6)}` });
      const partyId = String((client['detail'] as Body)['clientId']);
      await ok('task.set_party', {
        recordId: taskId,
        expectedRevision: task['revision'],
        fields: { client: partyId },
      });
      const pageUrl = await world.db.app.withBusiness(
        world.alpha,
        async (tx) => await bindAboutPage(tx, partyId, world.ada.actorId as string),
      );
      const opened = (
        await ok('review.open', {
          taskId,
          pageUrl,
          path: ABOUT_FILE,
          sourceRevision: `rev-${randomUUID()}`,
        })
      )['detail'] as Body;
      revisionId = String(opened['revisionId']);
      reviewId = String(opened['reviewId']);
      await ok('review.capture', { revisionId });
    }, 300_000);

    afterAll(async () => {
      await api?.stop();
      rmSync(scratch, { recursive: true, force: true });
      await world?.close();
    });

    it('files, decides and makes the task the same on the command line and the app route', async () => {
      const [cliPin, httpPin] = [await clientPin(), await clientPin()];
      const filed = [
        await cli('review.propose_change', filing(cliPin), world.ada),
        await http('review.propose_change', filing(httpPin), world.ada),
      ];
      expect(filed.map((a) => [a.code, detail(a)['state']])).toEqual([
        ['ok', 'proposed'],
        ['ok', 'proposed'],
      ]);
      expect(Object.keys(detail(filed[0] as Answer)).toSorted()).toEqual(
        Object.keys(detail(filed[1] as Answer)).toSorted(),
      );
      const again = [
        await cli('review.propose_change', filing(cliPin), world.ada),
        await http('review.propose_change', filing(httpPin), world.ada),
      ];
      expect(again.map((a) => a.code)).toEqual([
        'CHANGE_REQUEST_ALREADY_FILED',
        'CHANGE_REQUEST_ALREADY_FILED',
      ]);
      const [cliRequest, httpRequest] = filed.map((a) => detail(a)['changeRequestId']);
      const decided = [
        await cli('review.decide_change', approve(cliRequest), world.ada),
        await http('review.decide_change', approve(httpRequest), world.ada),
      ];
      expect(decided.map((a) => [a.code, detail(a)['state']])).toEqual([
        ['ok', 'approved'],
        ['ok', 'approved'],
      ]);
      const twice = [
        await cli('review.decide_change', approve(cliRequest), world.ada),
        await http('review.decide_change', approve(httpRequest), world.ada),
      ];
      expect(twice.map((a) => a.code)).toEqual([
        'CHANGE_REQUEST_ALREADY_DECIDED',
        'CHANGE_REQUEST_ALREADY_DECIDED',
      ]);
      const held = await lease();
      const make = (changeRequestId: unknown) => ({ ...held, changeRequestId });
      const made = [
        await cli('review.make_change_task', make(cliRequest), world.ada),
        await http('review.make_change_task', make(httpRequest), world.ada),
      ];
      expect(made.map((a) => a.code)).toEqual(['ok', 'ok']);
      expect(Object.keys(detail(made[0] as Answer)).toSorted()).toEqual(
        Object.keys(detail(made[1] as Answer)).toSorted(),
      );
      // A repeat on the other surface answers the task already made, on both.
      const repeat = [
        await cli('review.make_change_task', make(httpRequest), world.ada),
        await http('review.make_change_task', make(cliRequest), world.ada),
      ];
      expect(repeat.map((a) => a.code)).toEqual(['ok', 'ok']);
      expect(repeat.map((a) => a.body['recordId'])).toEqual([
        made[1]?.body['recordId'],
        made[0]?.body['recordId'],
      ]);
      const review = await cli('review.read', { reviewId }, world.ada);
      const requests = (review.body['review'] as { changeRequests: Body[] }).changeRequests;
      expect(requests.filter((r) => r['createdTaskId'] !== null)).toHaveLength(2);
    }, 300_000);

    it('refuses noah and bravo the same on both, and no refusal carries the client words', async () => {
      const commentId = await clientPin();
      const filed = detail(
        await cli('review.propose_change', { commentId, text: `Lift it ${MARKER}` }, world.ada),
      );
      const changeRequestId = filed['changeRequestId'];
      const cases: readonly (readonly [string, Body, Caller, string])[] = [
        ['review.propose_change', { commentId, text: 'mine' }, world.noah, 'alpha'],
        ['review.decide_change', { changeRequestId, decision: 'approve' }, world.noah, 'alpha'],
        ['review.decide_change', { changeRequestId, decision: 'refuse' }, world.noah, 'alpha'],
        ['review.read', { reviewId }, world.noah, 'alpha'],
        ['review.decide_change', { changeRequestId, decision: 'approve' }, world.bea, 'bravo'],
        ['review.read', { reviewId }, world.bea, 'bravo'],
      ];
      for (const [name, body, who, business] of cases) {
        // eslint-disable-next-line no-await-in-loop -- one served API, one call at a time
        const both = [await cli(name, body, who, business), await http(name, body, who, business)];
        expect(both[0]?.code, `${name} as ${who.name}`).not.toBe('ok');
        expect(both[0]?.code, `${name} as ${who.name}`).toBe(both[1]?.code);
        for (const answer of both) expect(answer.raw).not.toContain(MARKER);
      }
      const after = await cli('review.read', { reviewId }, world.ada);
      const request = (after.body['review'] as { changeRequests: Body[] }).changeRequests.find(
        (r) => r['changeRequestId'] === changeRequestId,
      );
      expect(request?.['state']).toBe('proposed');
      expect(String(request?.['text'])).toContain(MARKER);
    }, 300_000);
  },
);
