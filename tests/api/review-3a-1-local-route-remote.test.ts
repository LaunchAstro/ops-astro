// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-BATCH-2 #312, batch 3a, n=1: a route with reach 'local' is bound to
// whatever origin the operation's destination key names. `routeOf` checks only
// that the reach is known, and the conversation path picks local routes and
// dispatches to operation.destination. A local route whose destination is not
// loopback must be refused at configuration, not answered as configured.

import { expect, it } from 'vitest';
import { brokerSettings } from '../../apps/api/model-broker.ts';

const route = (reach: string) =>
  JSON.stringify([
    {
      key: 'replay',
      reach,
      provider: 'replay',
      credentialRef: 'replay_key',
      credentialKind: 'replay',
      installation: 'here',
      ceiling: 4,
    },
  ]);

const settingsFor = (origin: string, reach: string) =>
  brokerSettings({
    MODEL_BROKER_CREDENTIALS_FILE: '/run/broker/credentials.json',
    MODEL_BROKER_DESTINATIONS: JSON.stringify([{ key: 'replay', origin }]),
    MODEL_BROKER_ROUTES: route(reach),
    MODEL_BROKER_INSTALLATION: 'here',
  });

it('REVIEW-3A-1: control, a local route to a loopback destination is configured', () => {
  expect(settingsFor('http://127.0.0.1:9', 'local').kind).toBe('configured');
});

it('REVIEW-3A-1: a local route whose destination is a remote origin is refused, not configured', () => {
  const settings = settingsFor('https://api.vendor.example', 'local');
  expect(
    settings.kind,
    'a reach:local route bound to https://api.vendor.example must be invalid',
  ).toBe('invalid');
  if (settings.kind === 'invalid') {
    expect(settings.problem).not.toContain('api.vendor.example');
  }
});
