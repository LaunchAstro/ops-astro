// SPDX-License-Identifier: AGPL-3.0-only
//
// C55's link to the error sink (ORCH49 ruling): the sink's web address from
// `OPS_ERROR_SINK_URL`, never from the DSN, whose user part is the sink's key.
// No database: the function stops at start on a bad setting, before any read.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFunctionHandler } from '../../apps/api/function.ts';
import { errorSinkLink } from '../../apps/api/health/error-sink-link.ts';
import { TEST_ISSUER as ISSUER } from '../support/sign-in.ts';

const KEY_ID = 'test/c55-error-sink@1';
/** Nothing listens here: start-up reads no database. */
const NOWHERE = 'postgres://app:c55-sink@127.0.0.1:1/none';
const START = {
  DELEGATION_CREDENTIAL_KEY_ID: KEY_ID,
  DELEGATION_CREDENTIAL_KEYS: `${KEY_ID}:${randomBytes(32).toString('base64url')}`,
  DATABASE_URL: NOWHERE,
  GOTRUE_URL: ISSUER,
  SERVED_HOST: 'ops.example.test',
};
const SINK_CANARY = 'CANARY-c55-sink-key';
const DSN = `https://${SINK_CANARY}@errors.example.test/7`;
const ADDRESS = 'https://errors.example.test/organizations/ops/issues/';

describe('C55 error sink link', () => {
  it('C55 error sink link: the sink web address in OPS_ERROR_SINK_URL is the link', () => {
    expect(errorSinkLink({ OPS_ERROR_SINK_URL: ADDRESS })).toStrictEqual({ url: ADDRESS });
  });

  it('C55 error sink link: unset or empty is no link', () => {
    expect(errorSinkLink({})).toBeNull();
    expect(errorSinkLink({ OPS_ERROR_SINK_URL: '' })).toBeNull();
  });

  it('C55 error sink link: the DSN never appears, alone it gives no link, and in the setting it stops the function naming the setting, never the key', () => {
    expect(errorSinkLink({ OPS_ERROR_SINK_DSN: DSN })).toBeNull();
    const both = errorSinkLink({ OPS_ERROR_SINK_DSN: DSN, OPS_ERROR_SINK_URL: ADDRESS });
    expect(JSON.stringify(both)).not.toContain(SINK_CANARY);
    let problem = '';
    try {
      createFunctionHandler({ ...START, OPS_ERROR_SINK_URL: DSN });
    } catch (error) {
      problem = String(error);
    }
    expect(problem).toContain('OPS_ERROR_SINK_URL');
    expect(problem).not.toContain(SINK_CANARY);
  });

  it('C55 error sink link: a plain http address is refused', () => {
    expect(() => errorSinkLink({ OPS_ERROR_SINK_URL: 'http://errors.example.test/' })).toThrow(
      /OPS_ERROR_SINK_URL/u,
    );
  });
});
