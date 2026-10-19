// SPDX-License-Identifier: AGPL-3.0-only
//
// A6, provider independence (#1623 R8), under the kernel: core-agent's real
// loop runs in a network namespace holding only loopback and the labelled
// broker double and LangSmith recorder, as a uid with every capability and
// privilege escalation dropped. It ends a scripted `task.read` turn and a
// final answer in success, through its broker port; then every way out aimed
// at the supervisor's fixtures meets the kernel's refusal, and no fixture
// counter rises. Run only by `pnpm run agent:egress:conformance`, which
// writes the receipt this refuses without; `pnpm test` never collects it.
// No database.

import { Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { confinement, type Listener } from './egress-confinement.ts';
import { countersAt, egressProbes, type Outcome } from './egress-probes.ts';

// Taken before the agent stack is imported, as a tool holding it from then would.
const captured = Socket.prototype.connect;
const receipt = confinement(process.env, fileURLToPath(new URL('../../', import.meta.url)));
const { runAttempt } = await import('../../packages/core-agent/src/index.ts');
const { final, reads, scripted } = await import('../runs/agent-ports.ts');

/** The kernel's refusal each way out meets, by platform. */
const REFUSED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  linux: {
    'captured socket': 'ENETUNREACH',
    'raw tcp ipv4': 'ENETUNREACH',
    'raw tcp ipv6': 'ENETUNREACH',
    'fresh dns ipv4': 'ECONNREFUSED',
    'fresh dns ipv6': 'ECONNREFUSED',
    'fetch ipv4': 'ENETUNREACH',
    'fetch ipv6': 'ENETUNREACH',
    'child process': 'ENETUNREACH',
  },
};

const listener = (label: string): Listener => {
  const found = receipt.listeners.find((entry) => entry.label === label);
  if (found === undefined) throw new Error(`A6 refused: no ${label} listener`);
  return found;
};
const url = ({ address, port }: Listener, path: string): string =>
  `http://${address}:${String(port)}${path}`;
const broker = listener('broker-double');
const recorder = listener('langsmith-recorder');

describe('A6: the agent loop reaches no network', () => {
  it('ends a scripted task.read turn and a final answer in success through its broker port', async () => {
    const run = scripted((n) => (n === 1 ? reads(n) : final(n)));
    const ports = {
      ...run.ports,
      broker: {
        turn: async (turn: Parameters<typeof run.ports.broker.turn>[0]) => {
          const relayed = await fetch(url(broker, '/turn'), {
            method: 'POST',
            body: JSON.stringify(turn),
          });
          expect(relayed.status).toBe(200);
          return await run.ports.broker.turn(turn);
        },
      },
    };
    const end = await runAttempt(run.state, ports, 5, undefined, 'Read the task, then answer.');
    expect(end).toEqual({ outcome: 'success', endCode: 'COMPLETED' });
    expect(run.sent.map((turn) => turn.turnOrdinal)).toEqual([0, 1]);
    expect(run.toolRuns()).toBe(1);
    expect(run.ended).toEqual([]);
    expect(await (await fetch(url(broker, '/turns'))).json()).toEqual({ turns: [0, 1] });
    expect(await (await fetch(url(recorder, '/recorded'))).json()).toEqual({ recorded: 0 });
  });

  it('the captured socket, raw IPv4 and IPv6 TCP, fresh DNS, fetch and a child process each meet the kernel refusal, and no fixture counter rises', async () => {
    const before = countersAt(receipt.counters);
    const met: Record<string, Outcome> = {};
    for (const probe of egressProbes(receipt.fixtures, captured)) {
      // oxlint-disable-next-line no-await-in-loop -- one way out at a time, each against the same counters
      met[probe.name] = await probe.run();
    }
    await sleep(500);
    expect(countersAt(receipt.counters)).toEqual(before);
    const refused = REFUSED[process.platform] ?? {};
    expect(met).toEqual(
      Object.fromEntries(
        Object.entries(refused).map(([name, code]) => [name, { reached: false, code }]),
      ),
    );
  });
});
