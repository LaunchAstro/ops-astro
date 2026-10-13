// SPDX-License-Identifier: AGPL-3.0-only
//
// A plan answer nested far deeper than any Responses answer, inside the byte
// limit (#1620): custody withholds it and keeps serving; it never dies on
// it. Control: the same custody answers a plainly nested answer after it.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startCustody } from '../../packages/core-custody/src/agent.ts';
import { writeTokenFile } from '../../packages/core-custody/src/plan-token.ts';
import { fake } from '../worker/plan-fakes.ts';

// oxlint-disable-next-line max-lines-per-function -- one custody, its token file, the deep answer and the control after it
it('a bounded deeply nested Responses event cannot kill custody', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'sol-1634-deep-'));
  const provider = await fake();
  const tokenFile = join(folder, 'tokens.json');
  const credentialsFile = join(folder, 'credentials.json');
  writeTokenFile(tokenFile, {
    clientId: 'oaiapp_sol_fake',
    accessToken: 'synthetic-access-secret',
    refreshToken: 'synthetic-refresh-secret',
    expiresAt: Date.now() + 3_600_000,
  });
  writeFileSync(
    credentialsFile,
    JSON.stringify([
      {
        ref: 'chatgpt_plan',
        kind: 'subscription',
        account: 'owner',
        destination: 'chatgpt_plan',
        scheme: 'oauth_refresh',
        tokenFile,
        refreshDestination: 'chatgpt_sign_in',
      },
    ]),
    { mode: 0o600 },
  );
  const nested = '['.repeat(12000) + '0' + ']'.repeat(12000);
  const stream =
    'data: {"type":"response.completed","response":{"status":"completed","model":"gpt-6.1-luna","output":[],"usage":{"input_tokens":1,"output_tokens":1},"metadata":' +
    nested +
    '}}\n\n';
  expect(Buffer.byteLength(stream)).toBeLessThan(64 * 1024);
  provider.answer = () => ({ status: 200, type: 'text/event-stream', body: stream });
  const custody = await startCustody({
    credentialsFile,
    destinations: [
      { key: 'chatgpt_plan', origin: provider.origin, stream: 'responses_sse' },
      { key: 'chatgpt_sign_in', origin: provider.origin, post: false },
    ],
  });
  try {
    const outcome = await custody.dispatch('chatgpt_plan', {
      destination: 'chatgpt_plan',
      method: 'POST',
      path: '/v1/responses',
      body: '{}',
      timeoutMs: 5000,
      maxResponseBytes: 64 * 1024,
    });
    // Either a bounded answer or a withheld malformed event is safe. A
    // lost process also kills unrelated calls sharing this custody.
    expect.soft(outcome.kind).not.toBe('worker_lost');
    expect.soft(await custody.describe('chatgpt_plan', 'chatgpt_plan')).not.toBeNull();
    // Control: a plainly nested answer from the same custody, after it.
    const plain = stream.replace(nested, '{"note":"plain"}');
    provider.answer = () => ({ status: 200, type: 'text/event-stream', body: plain });
    const answered = await custody.dispatch('chatgpt_plan', {
      destination: 'chatgpt_plan',
      method: 'POST',
      path: '/v1/responses',
      body: '{}',
      timeoutMs: 5000,
      maxResponseBytes: 64 * 1024,
    });
    expect(answered.kind).toBe('answered');
  } finally {
    await custody.stop();
    await provider.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
