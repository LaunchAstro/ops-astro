// SPDX-License-Identifier: AGPL-3.0-only
//
// T2g, the gate's decisions on the command line against the real served API,
// beside the same request on the person's HTTP route the app posts to
// (product issue 17, RN-10). `request_changes` is a decision kind of
// `task.decide`, so the command line reaches it with no row of its own; the
// app's second control is the same request.
//
// Separations named: business to business (bravo's person asks about alpha's
// gate and is refused the same way on both surfaces, with nothing moved); person to person (noah, a
// member without the grant, is refused on both surfaces with the same code);
// an agent's own login is refused the decision the person's credential
// makes (isolation case 5), and it presents only its own login (case 9).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { runCli, serveApi, type Run, type ServedApi } from './cli-process-harness.ts';

interface Gate {
  readonly taskId: string;
  readonly gateId: string;
  readonly versionId: string;
}

const body = (gate: Gate, decision: string) => ({
  gateId: gate.gateId,
  versionId: gate.versionId,
  decision,
  note: `t2g ${decision}`,
});

describe.skipIf(serverUrl === undefined)(
  'T2g decisions on the command line and the app route',
  () => {
    let world: World;
    let api: ServedApi | undefined;
    let scratch: string;

    const as = (
      token: string,
      business = 'alpha',
      extra: Readonly<Record<string, string>> = {},
    ) => ({
      OPS_ASTRO_API_URL: (api as ServedApi).origin,
      OPS_ASTRO_BUSINESS: business,
      OPS_ASTRO_TOKEN: token,
      OPS_ASTRO_TOKEN_FILE: join(scratch, `token-${randomUUID()}`),
      OPS_ASTRO_DELEGATION_FILE: join(scratch, `delegation-${randomUUID()}`),
      ...extra,
    });

    /** A new task with one proposed version, through the command line. */
    async function proposed(): Promise<Gate> {
      const ada = as(world.ada.token);
      const task = await runCli(
        ['task.create', '--json', JSON.stringify({ fields: { title: 'a gate to decide' } })],
        ada,
      );
      const answer = await runCli(
        [
          'task.propose',
          '--json',
          JSON.stringify({
            recordId: task.json?.['recordId'],
            expectedRevision: task.json?.['revision'],
            purpose: `t2g_${randomUUID().slice(0, 8)}`,
            maximumMinor: 2_000,
            currency: 'AUD',
            payload: { change: 'a team-only comment' },
            step: { kind: 'synthetic_comment', payload: {} },
          }),
        ],
        ada,
      );
      const detail = answer.json?.['detail'] as Record<string, unknown> | undefined;
      if (detail === undefined) throw new Error(`no proposal: ${answer.stdout} ${answer.stderr}`);
      return {
        taskId: String(task.json?.['recordId']),
        gateId: String(detail['gateId']),
        versionId: String(detail['versionId']),
      };
    }

    const cli = async (gate: Gate, decision: string, env: Record<string, string>): Promise<Run> =>
      await runCli(['task.decide', '--json', JSON.stringify(body(gate, decision))], env);

    const http = async (gate: Gate, decision: string, token: string, business = 'alpha') => {
      const response = await fetch(`${(api as ServedApi).origin}/api/b/${business}/task/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ operationId: randomUUID(), ...body(gate, decision) }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    /** Ada completing the gate's task, on the command line and on the app route: each code. */
    const completing = async (gate: Gate): Promise<readonly unknown[]> => {
      const codes: unknown[] = [];
      for (const surface of ['cli', 'app'] as const) {
        // eslint-disable-next-line no-await-in-loop
        const read = await runCli(
          ['task.read', '--json', JSON.stringify({ recordId: gate.taskId })],
          as(world.ada.token),
        );
        const revision = (read.json?.['task'] as Record<string, unknown> | undefined)?.['revision'];
        const request = { recordId: gate.taskId, expectedRevision: revision };
        if (surface === 'cli') {
          // eslint-disable-next-line no-await-in-loop
          const run = await runCli(
            ['task.complete', '--json', JSON.stringify(request)],
            as(world.ada.token),
          );
          codes.push(run.json?.['code']);
        } else {
          // eslint-disable-next-line no-await-in-loop
          const response = await fetch(`${(api as ServedApi).origin}/api/b/alpha/task/complete`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${world.ada.token}`,
            },
            body: JSON.stringify({ operationId: randomUUID(), ...request }),
          });
          // eslint-disable-next-line no-await-in-loop
          codes.push(((await response.json()) as Record<string, unknown>)['code']);
        }
      }
      return codes;
    };

    const recorded = async (gate: Gate) =>
      await world.db.admin.execute<{ readonly decision: string; readonly state: string }>(
        `select d.decision, g.state from public.gates g
         left join public.gate_decisions d on d.gate_id = g.id
        where g.id = $1`,
        [gate.gateId],
      );

    beforeAll(async () => {
      world = await createWorld('t2gdecide');
      scratch = mkdtempSync(join(tmpdir(), 't2g-decide-'));
      api = await serveApi(world);
      await world.db.admin.execute(
        'update public.budget_caps set limit_minor = 1000000000 where business_id = $1',
        [world.alpha],
      );
    }, 120_000);

    afterAll(async () => {
      await api?.stop();
      if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
      await world?.close();
    }, 60_000);

    it('journey_parity_cli: request_changes records the same decision on the command line as on the app route', async () => {
      const onCli = await proposed();
      const onApp = await proposed();

      const run = await cli(onCli, 'request_changes', as(world.ada.token));
      expect(run.code, run.stdout + run.stderr).toBe(0);
      const answered = await http(onApp, 'request_changes', world.ada.token);
      expect(answered.status, JSON.stringify(answered.body)).toBe(200);

      const fromCli = await recorded(onCli);
      const fromApp = await recorded(onApp);
      expect(fromCli).toEqual(fromApp);
      expect(fromCli[0]?.decision).toBe('request_changes');
    });

    it('refuses the same things on both surfaces: another business, a person without the grant', async () => {
      const gate = await proposed();

      const bravoCli = await cli(gate, 'request_changes', as(world.bea.token, 'bravo'));
      const bravoApp = await http(gate, 'request_changes', world.bea.token, 'bravo');
      // Refused before any lookup, the same way on both surfaces, and nothing moves.
      expect(bravoCli.code).not.toBe(0);
      expect(bravoCli.json?.['code']).toBe(bravoApp.body['code']);
      expect(bravoApp.status).toBeGreaterThanOrEqual(400);

      const noahCli = await cli(gate, 'approve', as(world.noah.token));
      const noahApp = await http(gate, 'approve', world.noah.token);
      expect(noahCli.code).not.toBe(0);
      expect(noahCli.json?.['code']).toBe(noahApp.body['code']);

      expect(await recorded(gate)).toEqual([{ decision: null, state: 'pending' }]);
      // Nothing moved, as T2g reads it: the gate the crossings could not
      // decide still holds its task open, on both surfaces (contract 4.3).
      expect(await completing(gate)).toStrictEqual(['GATE_PENDING', 'GATE_PENDING']);
      // Beside its positive control: the grant holder's same call on the same
      // gate is recorded, so each refusal above is the crossing's, never a
      // command line that decides nothing for anyone.
      const adaCli = await cli(gate, 'request_changes', as(world.ada.token));
      expect(adaCli.code, adaCli.stdout + adaCli.stderr).toBe(0);
      expect(await recorded(gate)).toEqual([
        { decision: 'request_changes', state: 'changes_requested' },
      ]);
    });

    it("an agent's own login is refused the decision, which the person's credential then makes (cases 5 and 9)", async () => {
      const gate = await proposed();

      const agent = await cli(
        gate,
        'approve',
        as(world.agent.token, 'alpha', { OPS_ASTRO_AGENT: '1' }),
      );
      expect(agent.code).not.toBe(0);
      expect(`${agent.stdout}${agent.stderr}`).not.toContain(world.agent.token);
      expect(await recorded(gate)).toEqual([{ decision: null, state: 'pending' }]);

      const person = await cli(gate, 'approve', as(world.ada.token));
      expect(person.code, person.stdout + person.stderr).toBe(0);
      expect((await recorded(gate))[0]?.decision).toBe('approve');
    });
  },
);
