// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof for #1911 (S1911-2), assertions unchanged: the exported model
// invoked directly, with `LANGSMITH_TRACING=true`, a planted key and a real
// listener as LangSmith's endpoint, refuses before any turn, and LangSmith
// is sent nothing.

import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';

it('a direct model entry refuses tracing before LangSmith sees content', async () => {
  let hits = 0;
  const listener = createServer((request, response) => {
    hits += 1;
    request.resume();
    response.end('{}');
  });
  await new Promise<void>((listening) => {
    listener.listen(0, '127.0.0.1', listening);
  });
  try {
    const endpoint = `http://127.0.0.1:${String((listener.address() as AddressInfo).port)}`;
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        ['tests/runs/agent-direct-tracing-case.ts'],
        {
          env: {
            ...process.env,
            LANGSMITH_TRACING: 'true',
            LANGSMITH_ENDPOINT: endpoint,
            LANGSMITH_API_KEY: 'lsv2_planted',
          },
        },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        },
      );
    });
    expect({ ...JSON.parse(out), hits }).toEqual({ refused: true, sent: 0, hits: 0 });
  } finally {
    listener.close();
  }
});
