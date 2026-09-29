// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01: the API's composition root starts the credential broker only from a
// complete, well-formed configuration. None of the four settings means no
// broker, and `model.call` answers that it has not landed. Some of them, or a
// malformed one, stops the server with a problem that names the setting and
// never its value.

import { describe, expect, it } from 'vitest';
import { brokerSettings, MODEL_BROKER_SETTINGS } from '../../apps/api/model-broker.ts';

const CANARY = 'canary-7d1f0c2e9a';

const COMPLETE = {
  MODEL_BROKER_CREDENTIALS_FILE: '/run/broker/credentials.json',
  MODEL_BROKER_DESTINATIONS: JSON.stringify([{ key: 'replay', origin: 'http://127.0.0.1:9' }]),
  MODEL_BROKER_ROUTES: JSON.stringify([
    {
      key: 'replay',
      reach: 'cloud',
      provider: 'replay',
      credentialRef: 'replay_key',
      credentialKind: 'replay',
      installation: 'here',
    },
  ]),
  MODEL_BROKER_INSTALLATION: 'here',
} as const;

const problemOf = (environment: Readonly<Record<string, string | undefined>>): string => {
  const settings = brokerSettings(environment);
  if (settings.kind !== 'invalid') throw new Error(`expected invalid, got ${settings.kind}`);
  return settings.problem;
};

describe('AW-01 broker settings', () => {
  it('none set is no broker', () => {
    expect(brokerSettings({})).toEqual({ kind: 'absent' });
    expect(brokerSettings(Object.fromEntries(MODEL_BROKER_SETTINGS.map((n) => [n, ''])))).toEqual({
      kind: 'absent',
    });
  });

  it('a complete configuration is the broker', () => {
    const settings = brokerSettings(COMPLETE);
    expect(settings).toMatchObject({
      kind: 'configured',
      custody: {
        credentialsFile: COMPLETE.MODEL_BROKER_CREDENTIALS_FILE,
        destinations: [{ key: 'replay', origin: 'http://127.0.0.1:9' }],
      },
      installation: 'here',
      routes: [{ key: 'replay', reach: 'cloud', provider: 'replay' }],
    });
  });

  it('some set names the missing ones', () => {
    for (const missing of MODEL_BROKER_SETTINGS) {
      const problem = problemOf({ ...COMPLETE, [missing]: undefined });
      expect(problem).toContain(missing);
    }
  });

  it('a malformed setting is named and its value never shown', () => {
    const cases: readonly [string, string][] = [
      ['MODEL_BROKER_DESTINATIONS', `not json ${CANARY}`],
      ['MODEL_BROKER_DESTINATIONS', JSON.stringify([{ key: 'replay', origin: `ftp://${CANARY}` }])],
      [
        'MODEL_BROKER_DESTINATIONS',
        JSON.stringify([{ key: CANARY.toUpperCase(), origin: 'http://127.0.0.1:9' }]),
      ],
      ['MODEL_BROKER_ROUTES', `{${CANARY}`],
      ['MODEL_BROKER_ROUTES', JSON.stringify({ key: CANARY })],
      ['MODEL_BROKER_ROUTES', JSON.stringify([{ key: CANARY }])],
      [
        'MODEL_BROKER_ROUTES',
        JSON.stringify([{ ...JSON.parse(COMPLETE.MODEL_BROKER_ROUTES)[0], provider: CANARY }]),
      ],
      [
        'MODEL_BROKER_ROUTES',
        JSON.stringify([{ ...JSON.parse(COMPLETE.MODEL_BROKER_ROUTES)[0], reach: CANARY }]),
      ],
      [
        'MODEL_BROKER_ROUTES',
        JSON.stringify([
          { ...JSON.parse(COMPLETE.MODEL_BROKER_ROUTES)[0], credentialKind: CANARY },
        ]),
      ],
      [
        'MODEL_BROKER_ROUTES',
        JSON.stringify([{ ...JSON.parse(COMPLETE.MODEL_BROKER_ROUTES)[0], extra: CANARY }]),
      ],
    ];
    for (const [setting, value] of cases) {
      const problem = problemOf({ ...COMPLETE, [setting]: value });
      expect(problem).toContain(setting);
      expect(problem).not.toContain(CANARY);
      expect(problem.toLowerCase()).not.toContain(CANARY.toLowerCase());
    }
  });
});
