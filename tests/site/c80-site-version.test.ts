// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 publish binding, the approved version: the proposal carries the version
// digest of the bytes it proposed, and the publish merges it only when the
// runner's approved version is that one. A binding built from a proposal of
// other bytes sends nothing. Against the double behind the transport.

import { describe, expect, it } from 'vitest';
import { mergeAndFind, proposeSource } from '../../packages/core-connectors/src/index.ts';
import { siteRunnerPorts } from '../../packages/core-commands/src/commands/live-correction-ports.ts';
import { BEFORE, PAGE, SEAM, binding, proposal, proposed, provider } from './c80-site-provider.ts';

const APPROVED = 'digest-approved';
const bound = { ...binding, proposal: { ...binding.proposal, versionDigest: APPROVED } };

describe('C80 publish binding, the approved version', () => {
  it('the proposal carries the version digest of the bytes it proposed', async () => {
    const input = { ...proposal, versionDigest: APPROVED };
    const opened = await proposeSource(input, provider({ content: BEFORE }).deps);
    expect(opened).toMatchObject({ kind: 'ok', value: { versionDigest: APPROVED } });
  });

  it('a version other than the proposed one is refused with nothing sent', async () => {
    const site = proposed();
    const other = { seam: SEAM, versionDigest: 'digest-other' };
    expect(await mergeAndFind(bound, other, site.deps)).toEqual({
      kind: 'refused',
      code: 'PROPOSAL_SUPERSEDED',
    });
    expect([site.sent, site.recorded]).toEqual([[], ['PROPOSAL_SUPERSEDED']]);
  });

  it('through the bound ports, the runner approved version reaches the binding', async () => {
    const site = proposed();
    const ports = siteRunnerPorts(bound, {
      ...site.deps,
      capture: {
        pool: { agencyPages: [PAGE], otherPages: [], closedPoolReviews: [] },
        resolve: () => Promise.resolve([]),
        transport: () => Promise.resolve({ kind: 'timeout' }),
      },
      raiseTask: () => Promise.resolve(),
      now: () => 0,
    });
    const stale = { seam: SEAM, dispatchToken: 't', versionDigest: 'digest-other' };
    expect(await ports.publish(stale)).toMatchObject({ code: 'PROPOSAL_SUPERSEDED' });
    expect(site.sent).toEqual([]);
    const approved = { ...stale, versionDigest: APPROVED };
    expect(await ports.publish(approved)).toMatchObject({ kind: 'ok' });
    expect(site.sent.filter((sent) => sent.target.endsWith('/merge'))).toHaveLength(1);
  });
});
