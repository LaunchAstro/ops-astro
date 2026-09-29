// SPDX-License-Identifier: AGPL-3.0-only
//
// C60 no session token stored (LF-5): the product never stores a Claude.ai or
// ChatGPT session token. AW-01 refuses one at load by its plain shape
// (`AW-01 custody 6`); these are the shapes a person pastes from a browser
// instead: the cookie pair, a percent-encoded copy, and the chat product's own
// encrypted session value. Each is refused whatever kind it is filed under,
// and custody's real process names the entry, never the value. An ordinary
// API key and a signed cloud token still load.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, expect, it } from 'vitest';
import { parseCredentials } from '../../packages/core-custody/src/index.ts';
import { plantedKey } from './custody-world.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const dir = mkdtempSync(join(tmpdir(), 'c60-session-token-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const b64url = (text: string): string => Buffer.from(text).toString('base64url');

/** An encrypted session cookie's value, as the chat product's sign-in library writes it. */
const encryptedSession = (): string =>
  [
    b64url(JSON.stringify({ alg: 'dir', enc: 'A256GCM' })),
    '',
    b64url(plantedKey()),
    b64url(plantedKey()),
    b64url(plantedKey()),
  ].join('.');

/** Each shape a session token arrives in, pasted from a browser. */
const pasted = (): readonly (readonly [string, string])[] => [
  ['the Claude.ai cookie pair', `sessionKey=sk-ant-sid01-${plantedKey()}`],
  ['the cookie pair in other case', `SESSIONKEY=SK-ANT-SID01-${plantedKey()}`],
  ['a percent-encoded session key', `sk%2Dant%2Dsid01-${plantedKey()}`],
  ['a percent-encoded cookie pair', `sessionKey%3Dsk-ant-sid01-${plantedKey()}`],
  ["ChatGPT's encrypted session value", encryptedSession()],
  ["ChatGPT's cookie pair", `__Secure-next-auth.session-token.0=${encryptedSession()}`],
];

/** What a load came to, without the value, so no failure message ever prints it. */
const loaded = (kind: string, value: string): string => {
  const result = parseCredentials([entry(kind, value)]);
  return result.ok ? 'loaded' : `${result.code} at ${String(result.at)}`;
};

const entry = (kind: string, value: string): Record<string, unknown> => ({
  ref: 'filed_as_key',
  kind,
  account: 'x',
  destination: 'replay',
  header: 'authorization',
  value,
});

it.each(pasted())(
  'C60 no session token stored: %s is refused at load, filed as a key or a cloud credential',
  (_shape, value) => {
    for (const kind of ['api_key', 'cloud_credential']) {
      expect(loaded(kind, value)).toBe('SESSION_TOKEN_REFUSED at 0');
    }
  },
);

it("C60 no session token stored: custody's process refuses the pasted cookie and never prints it", () => {
  for (const [, value] of pasted()) {
    const file = join(dir, 'credentials.json');
    writeFileSync(file, JSON.stringify([entry('api_key', value)]), { mode: 0o600 });
    const output = (() => {
      try {
        execFileSync(process.execPath, [join(ROOT, 'packages/core-custody/src/custody-main.ts')], {
          env: { CUSTODY_CREDENTIALS_FILE: file, CUSTODY_DESTINATIONS: '[]' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return 'started';
      } catch (error) {
        const failed = error as { stderr: Buffer; status: number };
        return `${String(failed.status)} ${failed.stderr.toString('utf8')}`;
      }
    })();
    expect(output.includes(value)).toBe(false);
    expect(output.replaceAll(value, '[value]')).toMatch(
      /^78 custody: credential 0 refused SESSION_TOKEN_REFUSED/u,
    );
  }
});

it('C60 no session token stored: an API key and a signed cloud token still load', () => {
  const signed = [
    b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    b64url(JSON.stringify({ aud: 'cloud' })),
    b64url(plantedKey()),
  ].join('.');
  for (const [kind, value] of [
    ['api_key', `sk-ant-api03-${plantedKey()}`],
    ['api_key', `sk-proj-${plantedKey()}`],
    ['cloud_credential', signed],
  ] as const) {
    expect(loaded(kind, value)).toBe('loaded');
  }
});
