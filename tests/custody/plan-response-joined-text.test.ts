// SPDX-License-Identifier: AGPL-3.0-only
//
// The plan's answer, folded in custody (#1620): an access token split between
// two completed output_text parts, which the reader joins, never leaves
// custody whole; the answer is withheld instead.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startCustody } from '../../packages/core-custody/src/agent.ts';
import {
  chatgptPlanRequest,
  readChatgptPlanAnswer,
} from '../../packages/core-connectors/src/index.ts';
import { fake } from '../worker/plan-fakes.ts';

// oxlint-disable-next-line max-lines-per-function -- one custody, its token file and the split answer, end to end
it('a token split between two completed text parts never leaves custody', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'sol-plan-text-'));
  const provider = await fake();
  const access = 'access-owner-secret-xxxxxxxxxxxx';
  const refresh = 'refresh-owner-secret-xxxxxxxxxxxx';
  const tokenFile = join(folder, 'tokens.json');
  const credentialsFile = join(folder, 'credentials.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({
      clientId: 'oaiapp_sol_fake',
      accessToken: access,
      refreshToken: refresh,
      expiresAt: Date.now() + 3_600_000,
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    credentialsFile,
    JSON.stringify([
      {
        ref: 'chatgpt_plan',
        kind: 'subscription',
        account: 'owner-plan',
        destination: 'chatgpt_plan',
        scheme: 'oauth_refresh',
        tokenFile,
        refreshDestination: 'chatgpt_sign_in',
      },
    ]),
    { mode: 0o600 },
  );
  const response = {
    status: 'completed',
    model: 'gpt-6.1-luna',
    usage: { input_tokens: 1, output_tokens: 1 },
    output: [
      {
        type: 'message',
        content: [access.slice(0, 13), access.slice(13)].map((text) => ({
          type: 'output_text',
          text,
        })),
      },
    ],
  };
  provider.answer = () => ({
    status: 200,
    type: 'text/event-stream',
    body: `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
  });
  let custody: Awaited<ReturnType<typeof startCustody>> | undefined;
  try {
    custody = await startCustody({
      credentialsFile,
      destinations: [
        { key: 'chatgpt_plan', origin: provider.origin, stream: 'responses_sse' },
        { key: 'chatgpt_sign_in', origin: provider.origin, post: false },
      ],
    });
    const built = chatgptPlanRequest({ model: 'gpt-6.1-luna', instructions: 'i', input: [] });
    const outcome = await custody.dispatch('chatgpt_plan', {
      ...built,
      destination: 'chatgpt_plan',
      timeoutMs: 5_000,
      maxResponseBytes: 64 * 1024,
    });
    expect(provider.heard[0]?.headers.authorization).toBe(`Bearer ${access}`);
    if (outcome.kind === 'withheld') return;
    if (outcome.kind !== 'answered' || !outcome.outbound.ok)
      throw new Error('expected provider answer');
    const answer = readChatgptPlanAnswer(JSON.parse(outcome.outbound.body));
    expect(answer).toBeDefined();
    expect(answer?.text).not.toContain(access);
  } finally {
    await custody?.stop();
    await provider.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
