// SPDX-License-Identifier: AGPL-3.0-only
//
// How a proof drives the real app: one request through `app.fetch`, and the
// answer read back as the caller would read it. `world.ts` re-exports all of
// it, so every proof keeps one import for the fixture.

import type { createApi } from '../../apps/api/app.ts';

export interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  /** The refusal code, or `ok` when the answer was a success. */
  readonly code: string;
  /** The body exactly as it came back, so a replay can be compared byte for byte. */
  readonly text: string;
}

/**
 * Drive the real app the way a caller does.
 *
 * The body is read as text first and parsed after: a fault and a missing route
 * answer in plain text, and a helper that could only read JSON would report
 * those as its own failure rather than as the status being asked about.
 */
export async function call(
  api: ReturnType<typeof createApi>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const response = await api.fetch(
    new Request(`http://api.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    parsed = { raw: text };
  }
  const code = parsed['refused'] === true ? String(parsed['code']) : 'ok';
  return { status: response.status, body: parsed, code, text };
}

export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

/** The person prefix and the agent prefix, spelled once. */
export const personPath = (businessKey: string, path: string): string =>
  `/api/b/${businessKey}${path}`;
export const agentPath = (businessKey: string, path: string): string =>
  `/api/a/b/${businessKey}${path}`;
