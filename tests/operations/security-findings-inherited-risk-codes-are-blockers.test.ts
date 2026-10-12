// SPDX-License-Identifier: AGPL-3.0-only
//
// A risk code the closing rule does not map is a blocker
// (`scripts/security/findings.ts`). A code naming a key every object inherits,
// such as `toString` or `__proto__`, is unmapped too: it fails the gate as a
// blocker, never reads the inherited value as a severity the gate cannot count.

import { expect, it } from 'vitest';
import { findingsOf, severityGate } from '../../scripts/security/findings.ts';

const reportWith = (riskcode: string) => ({
  site: [
    {
      '@name': 'https://staging.example.test',
      alerts: [
        {
          pluginid: '10001',
          name: 'Odd risk',
          riskcode,
          instances: [{ uri: 'https://staging.example.test/a', method: 'GET' }],
        },
      ],
    },
  ],
});

it.each(['toString', '__proto__', 'constructor', 'hasOwnProperty'])(
  'a risk code naming the inherited key %s is a blocker that fails the gate',
  (riskcode) => {
    const found = findingsOf('api', reportWith(riskcode));
    expect(found.findings.map((each) => each.severity)).toStrictEqual(['blocker']);
    expect(found.findings[0]?.rule).toContain('unmapped risk code');
    expect(severityGate([found])).toMatchObject({ fails: true, blocker: 1 });
  },
);
