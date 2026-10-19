// SPDX-License-Identifier: AGPL-3.0-only
//
// The only listeners inside A6's confined namespace
// (agent-egress-conformance.sh), each on loopback and labelled: the broker
// double, which takes each turn the agent's broker port relays and lists
// their ordinals, and the LangSmith recorder, which counts any request at all
// (the suite points LANGSMITH_ENDPOINT at it and expects none). Their labels
// and ports go to `<work>/listeners.json` for the receipt.
//
//   node agent-egress-doubles.ts <work> <broker port> <recorder port>

import { renameSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';

const [work = '', brokerPort = '', recorderPort = ''] = process.argv.slice(2);
const ADDRESS = '127.0.0.1';

const body = async (request: IncomingMessage): Promise<string> => {
  let text = '';
  for await (const chunk of request) text += String(chunk);
  return text;
};

const reply = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};

const turns: number[] = [];
let recorded = 0;

const routes: Readonly<
  Record<string, (request: IncomingMessage, response: ServerResponse) => Promise<void>>
> = {
  'broker-double': async (request, response) => {
    if (request.method === 'POST' && request.url === '/turn') {
      const turn = JSON.parse(await body(request)) as { turnOrdinal: number };
      turns.push(turn.turnOrdinal);
      reply(response, 200, { received: turns.length });
    } else if (request.url === '/turns') {
      reply(response, 200, { turns });
    } else {
      reply(response, 404, {});
    }
  },
  'langsmith-recorder': async (request, response) => {
    if (request.method === 'GET' && request.url === '/recorded') {
      reply(response, 200, { recorded });
      return;
    }
    recorded += 1;
    await body(request);
    reply(response, 202, {});
  },
};

const listening = (
  label: string,
  port: number,
): Promise<{ label: string; address: string; port: number }> =>
  new Promise((resolve) => {
    const route = routes[label];
    const server = createServer((request, response) => {
      void route?.(request, response);
    });
    server.listen({ host: ADDRESS, port }, () => {
      resolve({ label, address: ADDRESS, port });
    });
  });

const listeners = await Promise.all([
  listening('broker-double', Number(brokerPort)),
  listening('langsmith-recorder', Number(recorderPort)),
]);
const file = join(work, 'listeners.json');
writeFileSync(`${file}.next`, JSON.stringify(listeners));
renameSync(`${file}.next`, file);
