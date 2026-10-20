// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-2: the authority-change alert covers custody and client sharing as well
// as grants. A secret set or cleared, and a task shared with its client or
// the share taken back, each change who may reach what, so a successful one
// is the authority-changed signal and raises the alert at once. The grant
// itself (`access.grant`) is the control. A refused one changes nothing.

import { expect, it } from 'vitest';
import { createDetector, signalOf } from '../../apps/api/alerts/detect.ts';

const outcome = { business: 'alpha', person: 'supabase\u0000pat', items: 0 };

for (const command of [
  'access.grant',
  'secret.set',
  'secret.clear',
  'task.share_with_client',
  'task.revoke_client_share',
]) {
  it(`a successful ${command} raises the authority-change alert`, () => {
    const signal = signalOf({ ...outcome, command, refusal: undefined });
    expect(signal).toEqual({ kind: 'authority-changed', business: 'alpha' });
    const raised: string[] = [];
    createDetector((kind) => raised.push(kind)).observe(signal!);
    expect(raised).toEqual(['authority-changed']);
  });

  it(`a refused ${command} is no authority change`, () => {
    expect(signalOf({ ...outcome, command, refusal: 'NOT_FOUND' })).toBeUndefined();
  });
}
