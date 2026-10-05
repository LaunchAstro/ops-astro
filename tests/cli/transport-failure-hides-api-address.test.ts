// SPDX-License-Identifier: AGPL-3.0-only
//
// A request with no answer names the API it tried by scheme and host only.
// The configured address can carry a password in its user part, a key in its
// query or a token in its path, and the command line and the worker each
// print a line when the request fails; neither line may show any of them.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { main as cli } from '../../apps/cli/main.ts';
import { main as worker } from '../../apps/worker/main.ts';
import { streamText } from '../support/console-text.ts';

const CANARY = 'canary-7f3e0a91';
/**
 * Fetch refuses a user part before connecting; the others reach a closed port.
 * A `/` inside the user part makes the parser end the host early, so the start
 * of the secret would read as the host.
 */
const ADDRESSES = [
  `http://ops:${CANARY}@127.0.0.1:9`,
  `http://127.0.0.1:9/?key=${CANARY}`,
  `http://127.0.0.1:9/${CANARY}`,
  `http://${CANARY}/rest@127.0.0.1:9`,
] as const;

const SETTINGS = {
  OPS_ASTRO_BUSINESS: 'alpha',
  OPS_ASTRO_TOKEN: 'made-up-token',
  OPS_ASTRO_DELEGATION: 'made-up-delegation',
};

function expectHidden(streams: readonly string[], address: string): void {
  const printed = streams.join('\n');
  expect(printed).toMatch(
    /no answer from (?:http:\/\/127\.0\.0\.1:9|the configured API address)$/mu,
  );
  expect(printed).not.toContain(CANARY);
  expect(printed).not.toContain(address);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a failed request never prints a secret from the API address', () => {
  it.each(ADDRESSES)('the command line exits 3 and hides %s', async (address) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await cli(
      ['task.create', '--json', '{"fields":{"title":"t"}}'],
      { ...SETTINGS, OPS_ASTRO_API_URL: address },
      {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        stdin: () => Promise.resolve(''),
      },
    );
    expect(code).toBe(3);
    expectHidden([...out, ...err], address);
  });

  it.each(ADDRESSES)('the worker exits 4 and hides %s', async (address) => {
    const printed: string[] = [];
    const capture = (chunk: string | Uint8Array): boolean => {
      printed.push(streamText(chunk));
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    vi.spyOn(process.stderr, 'write').mockImplementation(capture);
    const code = await worker(['--once'], { ...SETTINGS, OPS_ASTRO_API_URL: address }, () =>
      Promise.resolve('sent'),
    );
    vi.restoreAllMocks();
    expect(code).toBe(4);
    expectHidden(printed, address);
  });
});

describe('a failed verb line never prints a secret from the address or the bearer', () => {
  it.each(ADDRESSES)('the agent verb line exits 3 and hides %s', async (address) => {
    const printed: string[] = [];
    const io = {
      out: (line: string) => printed.push(line),
      err: (line: string) => printed.push(line),
      stdin: () => Promise.resolve(''),
    };
    const code = await cli(
      ['task', 'get', 'some-task'],
      { ...SETTINGS, OPS_ASTRO_API_URL: address },
      io,
    );
    expect(code).toBe(3);
    expectHidden(printed, address);
  });

  it('the agent verb line hides a bearer the request could not carry', async () => {
    const printed: string[] = [];
    const io = {
      out: (line: string) => printed.push(line),
      err: (line: string) => printed.push(line),
      stdin: () => Promise.resolve(''),
    };
    const settings = { ...SETTINGS, OPS_ASTRO_TOKEN: `made-up\n${CANARY}` };
    const code = await cli(
      ['task', 'get', 'some-task'],
      { ...settings, OPS_ASTRO_API_URL: 'http://127.0.0.1:9' },
      io,
    );
    expect(code).toBe(3);
    expectHidden(printed, 'http://127.0.0.1:9/');
  });
});
