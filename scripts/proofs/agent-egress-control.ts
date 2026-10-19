// SPDX-License-Identifier: AGPL-3.0-only
//
// A6's healthy control (agent-egress-conformance.sh): the same ways out the
// confined suite aims, run from an unconfined process with the same dropped
// identity. Each must reach its fixture and raise its counter, or the
// confined suite's refusals would prove nothing.
//
//   node agent-egress-control.ts <counters.json>   (A6_IPV4, A6_IPV6, A6_TCP_PORT, A6_DNS_PORT, A6_NAME)

import { Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  countersAt,
  egressProbes,
  type Counters,
  type Probe,
} from '../../tests/harness/egress-probes.ts';

const captured = Socket.prototype.connect;
const counters = process.argv[2] ?? '';
const targets = {
  ipv4: process.env['A6_IPV4'] ?? '',
  ipv6: process.env['A6_IPV6'] ?? '',
  tcpPort: Number(process.env['A6_TCP_PORT']),
  dnsPort: Number(process.env['A6_DNS_PORT']),
  name: process.env['A6_NAME'] ?? '',
};

/** The counter after `probe`, once it has risen past `before` or two seconds have gone. */
async function risen(probe: Probe, before: Counters): Promise<number> {
  for (let waited = 0; waited < 2000; waited += 50) {
    const now = countersAt(counters)[probe.counter];
    if (now > before[probe.counter]) return now;
    // oxlint-disable-next-line no-await-in-loop -- polling the fixture's counter
    await sleep(50);
  }
  return countersAt(counters)[probe.counter];
}

let failed = 0;
for (const probe of egressProbes(targets, captured)) {
  const before = countersAt(counters);
  // oxlint-disable-next-line no-await-in-loop -- one way out at a time, each against its counter
  const met = await probe.run();
  // oxlint-disable-next-line no-await-in-loop -- as above
  const after = await risen(probe, before);
  const ok = met.reached && after > before[probe.counter];
  if (!ok) failed += 1;
  console.log(
    `agent-egress control: ${ok ? 'reached' : 'FAILED'} ${probe.name}` +
      ` (${probe.counter} ${String(before[probe.counter])} -> ${String(after)}${met.code === '' ? '' : `, ${met.code}`})`,
  );
}
process.exit(failed === 0 ? 0 : 1);
