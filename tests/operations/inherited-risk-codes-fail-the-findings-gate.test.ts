// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { findingsOf, severityGate } from '../../scripts/security/findings.ts';

it('inherited risk codes fail the security findings gate as blockers', () => {
  for (const riskcode of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
    const scan = findingsOf('api', {
      site: [
        {
          alerts: [
            { riskcode, name: 'Unknown risk', instances: [{ uri: 'https://example.test' }] },
          ],
        },
      ],
    });
    expect(severityGate([scan]), riskcode).toMatchObject({ fails: true, blocker: 1 });
    expect(scan.findings[0]?.severity, riskcode).toBe('blocker');
  }
});
