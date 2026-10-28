// SPDX-License-Identifier: AGPL-3.0-only
//
// The model agent world's custody credentials and destinations: Ollama's
// filed as `none`, and made-up bearer keys for the stand-in OpenRouter and
// the stand-in Hermes Agent, each at its own destination, whose streams
// custody decodes as OpenAI-shaped events.

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Destination } from '../../packages/core-custody/src/agent.ts';
import type { OpenRouterStandIn } from '../api/openrouter-stand-in-fixture.ts';

/** The made-up key custody presents to the stand-in OpenRouter. */
export const BEARER: string = `or-test-${randomUUID()}`;
/** The made-up key custody presents to the stand-in Hermes Agent. */
export const HERMES_BEARER: string = `hermes-test-${randomUUID()}`;

/** A bearer key custody presents at `ref`'s own destination. */
const bearer = (ref: string, account: string, value: string) => ({
  ref,
  kind: 'api_key',
  account,
  destination: ref,
  header: 'authorization',
  scheme: 'bearer',
  value,
});

export function writeNoneCredential(folder: string, paid: boolean, hermes: boolean): string {
  const file = join(folder, 'credentials.json');
  const entry = {
    ref: 'ollama_key',
    kind: 'api_key',
    account: 'm5-ollama',
    destination: 'ollama',
    scheme: 'none',
  };
  const entries = [
    entry,
    ...(paid ? [bearer('openrouter', 'agency-astro-openrouter', BEARER)] : []),
    ...(hermes ? [bearer('hermes', 'm5-hermes', HERMES_BEARER)] : []),
  ];
  writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
  return file;
}

/** A stand-in's destination, its stream decoded as OpenAI-shaped events, where it is up. */
export const decoded = (
  key: string,
  standIn: OpenRouterStandIn | undefined,
): readonly Destination[] =>
  standIn === undefined ? [] : [{ key, origin: standIn.origin, stream: 'openai_sse' }];
