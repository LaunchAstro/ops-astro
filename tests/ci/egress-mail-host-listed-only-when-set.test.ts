// SPDX-License-Identifier: AGPL-3.0-only
//
// The M5 relay's way out for the mail unit. The mail provider's host joins
// the allow-list only when OPS_EGRESS_MAIL_HOST is set, as a sixth entry on
// port 443 from that setting alone; unset, the relay's five stand as they
// were, so a deployment without the mail unit changes nothing. A value that
// is not a host name stops the relay, naming the setting and never the value.

import { expect, it } from 'vitest';

type EgressModule = {
  allowList: (env: Record<string, string | undefined>) => [string, number][];
};
const EGRESS = '../../scripts/ops/egress.mjs';
const { allowList } = (await import(
  /* @vite-ignore */
  EGRESS
)) as EgressModule;

const FIVE = {
  OPS_ASTRO_API_URL: 'https://api.example.test',
  OPS_EGRESS_POOLER_HOST: 'pooler.example.test',
  OPS_EGRESS_POOLER_PORT: '6543',
  OPS_EGRESS_HEARTBEAT_HOST: 'beat.example.test',
  OPS_EGRESS_SINK_HOST: 'sink.example.test',
  OPS_EGRESS_AUTH_HOST: 'auth.example.test',
};

it('unset, the relay lists its five and no mail host', () => {
  expect(allowList(FIVE)).toHaveLength(5);
  expect(allowList({ ...FIVE, OPS_EGRESS_MAIL_HOST: '' })).toEqual(allowList(FIVE));
});

it('set, the mail host is the sixth, on 443, and nothing else changes', () => {
  expect(allowList({ ...FIVE, OPS_EGRESS_MAIL_HOST: 'mail.example.test' })).toEqual([
    ...allowList(FIVE),
    ['mail.example.test', 443],
  ]);
});

it('a mail host that is not a host name stops the relay, naming the setting only', () => {
  for (const value of [
    'https://mail.secret.test',
    'mail.secret.test:443',
    'mail secret',
    '-x.test',
  ]) {
    expect(() => allowList({ ...FIVE, OPS_EGRESS_MAIL_HOST: value }), value).toThrow(
      /^OPS_EGRESS_MAIL_HOST is not set to a host name\.$/u,
    );
  }
});
