// SPDX-License-Identifier: AGPL-3.0-only
//
// The plan token's rotated pair, when its first write fails (#1620): it is
// written on a later call, and if it has expired by then it is refreshed
// before use, never presented dead. Control: a delayed pair still live is
// written and presented with no further refresh.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  readTokenFile,
  tokenHolder,
  writeTokenFile,
} from '../../packages/core-custody/src/plan-token.ts';

it('a delayed store never presents an expired rotated access token', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'sol-1634-expiry-'));
  const file = join(folder, 'tokens.json');
  let clock = 1_000_000;
  let diskFull = true;
  let refreshes = 0;
  writeTokenFile(file, {
    clientId: 'oaiapp_sol_fake',
    accessToken: 'access-initial-secret',
    refreshToken: 'refresh-initial-secret',
    expiresAt: clock - 1,
  });
  const holder = tokenHolder({
    file,
    tokenUrl: 'https://issuer.example.test/token',
    now: () => clock,
    fetch: () => {
      refreshes += 1;
      return Promise.resolve(
        Response.json({
          access_token: `access-rotated-${refreshes}`,
          refresh_token: `refresh-rotated-${refreshes}`,
          expires_in: 3600,
        }),
      );
    },
    write: (path, tokens) => {
      if (diskFull) throw new Error('simulated full disk');
      writeTokenFile(path, tokens);
    },
  });
  try {
    expect(await holder.current()).toEqual({ ok: false, code: 'SUBSCRIPTION_STORE_FAILED' });
    clock += 3_600_001;
    diskFull = false;
    const answer = await holder.current();
    expect(answer.ok).toBe(true);
    const kept = readTokenFile(file);
    if (typeof kept === 'string') throw new Error(kept);
    expect(kept.expiresAt, 'the access token returned for use must still be live').toBeGreaterThan(
      clock,
    );
    expect(answer).toEqual({ ok: true, accessToken: 'access-rotated-2' });
    expect(refreshes).toBe(2);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

it('control: a delayed pair still live is written and presented with no further refresh', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'plan-delayed-'));
  const file = join(folder, 'tokens.json');
  let clock = 1_000_000;
  let diskFull = true;
  let refreshes = 0;
  writeTokenFile(file, {
    clientId: 'oaiapp_fake',
    accessToken: 'access-initial-secret',
    refreshToken: 'refresh-initial-secret',
    expiresAt: clock - 1,
  });
  const holder = tokenHolder({
    file,
    tokenUrl: 'https://issuer.example.test/token',
    now: () => clock,
    fetch: () => {
      refreshes += 1;
      return Promise.resolve(
        Response.json({
          access_token: `access-rotated-${refreshes}`,
          refresh_token: `refresh-rotated-${refreshes}`,
          expires_in: 3600,
        }),
      );
    },
    write: (path, tokens) => {
      if (diskFull) throw new Error('simulated full disk');
      writeTokenFile(path, tokens);
    },
  });
  try {
    expect(await holder.current()).toEqual({ ok: false, code: 'SUBSCRIPTION_STORE_FAILED' });
    clock += 60_000;
    diskFull = false;
    expect(await holder.current()).toEqual({ ok: true, accessToken: 'access-rotated-1' });
    expect(refreshes).toBe(1);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
