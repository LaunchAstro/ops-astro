// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// C60: a client's written request for model use is that client's alone.
// Choosing another client on the privacy card leaves none of the first
// client's request on the card or in the save. The command case, against the
// real `client.set_privacy`, is tests/authority/c60-privacy-request-stays-with-its-client.test.tsx.

import { describe, expect, it } from 'vitest';
import type { AccessReadResult } from '../../packages/core-wire/src/index.ts';
import {
  FIRST_REQUEST,
  privacyCard,
  save,
  shownRequest,
  switchClientsMidRequest,
  type Body,
} from './c60-privacy-client-switch-steps.tsx';

const OFF = { modelEgress: false, providers: [], handlesHealth: false, noAgentEdits: false };
const A = { clientId: 'c-acme', name: 'Acme Dental' };
const B = { clientId: 'c-bolt', name: 'Bolt Physio' };

const RESULT = {
  ok: true,
  team: [],
  clients: [],
  agents: [],
  clientRecords: [A, B],
  clientPrivacy: [
    { clientId: A.clientId, ...OFF },
    { clientId: B.clientId, ...OFF },
  ],
} as unknown as AccessReadResult;

describe('C60 a written request stays with its client', () => {
  it('choosing another client clears the first client’s request, and the save carries none of it', async () => {
    const saved: Body[] = [];
    const page = await privacyCard(RESULT, (body) => saved.push(body));
    await switchClientsMidRequest(page, A.name, B.name);
    expect(shownRequest(page)).toStrictEqual(['', '', '']);
    await save(page);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.['clientId']).toBe(B.clientId);
    for (const [key, value] of Object.entries(FIRST_REQUEST)) {
      expect(saved[0]?.[key]).toBeUndefined();
      expect(JSON.stringify(saved)).not.toContain(value);
    }
  });
});
