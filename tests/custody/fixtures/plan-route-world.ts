// SPDX-License-Identifier: AGPL-3.0-only
//
// The chatgpt-plan route behind custody's real process (#1620 P4): a stand-in
// for the Responses endpoint on loopback that keeps every request it is sent,
// a token file holding a live pair, and custody forked as the model agent
// starts it, its plan holder built on the plan issuer. A live pair needs no
// refresh, so nothing reaches the issuer. Requests go through the agent's own
// mapping (`agentCustody`), written by a deadline as the agent writes them.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHATGPT_PLAN_ANSWER_BYTES,
  CHATGPT_PLAN_ISSUER,
  CHATGPT_PLAN_PATH,
  CHATGPT_PLAN_PROVIDER,
  CHATGPT_PLAN_TIMEOUT_MS,
  chatgptPlanBody,
  type PlanAsk,
  type PlanTool,
} from '../../../packages/core-connectors/src/index.ts';
import {
  SEND_WINDOW_MS,
  startCustody,
  type CustodyOutcome,
  type OutboundRequest,
  type ProcessCustody,
} from '../../../packages/core-custody/src/agent.ts';
import { agentCustody } from '../../../apps/model-agent/main.ts';
import { ACCESS, REFRESH, completed, sse, stream } from './plan-answer-world.ts';
import { HOUR, seed, tempDir } from './plan-token-world.ts';

/** One request as the stand-in heard it. */
export interface Sent {
  readonly path: string;
  readonly method: string;
  readonly authorization: string | undefined;
  readonly raw: string;
}

/** What the stand-in answers: a status, a body and its media type. */
export interface Reply {
  readonly status: number;
  readonly body: string;
  readonly type?: string;
}

export const ASK: PlanAsk = {
  model: 'gpt-6.1-luna',
  instructions: 'Draft the About page change the task asks for.',
  input: [{ role: 'user', content: 'Fix the opening hours on the About page.' }],
};

export const TOOL: PlanTool = {
  name: 'update_page',
  description: 'Change the words on one page of the site.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
};

/** The plan request the agent hands custody for `ask`. */
export const planRequest = (ask: PlanAsk = ASK): OutboundRequest => ({
  destination: CHATGPT_PLAN_PROVIDER,
  path: CHATGPT_PLAN_PATH,
  method: 'POST',
  body: chatgptPlanBody(ask),
  timeoutMs: CHATGPT_PLAN_TIMEOUT_MS,
  maxResponseBytes: CHATGPT_PLAN_ANSWER_BYTES,
});

/** A completed answer with these words, streamed. */
export const words = (text: string): Reply => ({
  status: 200,
  type: 'text/event-stream',
  body: stream(completed([text]), [text]),
});

/** A completed turn whose one output item is a call of `name` with `args`. */
export function toolCallReply(name: string, args: string, callId = 'call_1'): Reply {
  const call = { type: 'function_call', id: 'fc_1', call_id: callId, name, arguments: args };
  const response = { ...completed([]), output: [{ ...call, status: 'completed' }] };
  return {
    status: 200,
    type: 'text/event-stream',
    body: sse([
      { type: 'response.created', response: { id: 'resp_synthetic', status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: args },
      { type: 'response.output_item.done', output_index: 0, item: call },
      { type: 'response.completed', response },
    ]),
  };
}

export interface PlanRouteWorld {
  readonly custody: ProcessCustody;
  /** The live pair's access token, for checks only: never printed. */
  readonly token: string;
  /** Every request the stand-in heard. */
  readonly sent: Sent[];
  /** What the stand-in answers next; a case swaps it. */
  reply: (sent: Sent) => Reply;
  /** Pieces custody passed on while it answered. */
  readonly pieces: string[];
  /** One request through the agent's mapping, written by the agent's send deadline. */
  dispatch(request: OutboundRequest): Promise<CustodyOutcome>;
  /** Custody as the model agent sees it, for a case that runs the agent itself. */
  readonly agentCustody: ReturnType<typeof agentCustody>;
  close(): Promise<void>;
}

export interface PlanRouteOptions {
  /** The token file: a live pair (the default), or none at all. */
  readonly token?: 'live' | 'absent';
  /** The issuer custody is told; the plan's own unless a case names another. */
  readonly issuer?: string;
}

/** The Responses stand-in: every request kept, each answered as the case says. */
async function standIn(world: {
  readonly sent: Sent[];
  reply: (sent: Sent) => Reply;
}): Promise<{ readonly origin: string; close(): Promise<void> }> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const sent: Sent = {
        path: request.url ?? '',
        method: request.method ?? '',
        authorization: request.headers.authorization,
        raw: Buffer.concat(chunks).toString('utf8'),
      };
      world.sent.push(sent);
      const answer = world.reply(sent);
      response.writeHead(answer.status, { 'content-type': answer.type ?? 'application/json' });
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    close: async () =>
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// oxlint-disable-next-line max-lines-per-function -- the token file, the stand-in and custody, and their close
export async function openPlanRouteWorld(options: PlanRouteOptions = {}): Promise<PlanRouteWorld> {
  const dir = tempDir();
  if (options.token !== 'absent') {
    const tokens = {
      clientId: 'synthetic-client-id',
      accessToken: ACCESS,
      refreshToken: REFRESH,
      subject: 'synthetic-subject-a',
      expiresAt: Date.now() + 2 * HOUR,
    };
    await seed(dir.file, { state: 'ready', tokens });
  }
  const credentialsFile = join(dir.dir, 'credentials.json');
  writeFileSync(credentialsFile, '[]', { mode: 0o600 });
  const box = { sent: [] as Sent[], reply: (_sent: Sent): Reply => words('Weekdays 8 to 5.') };
  const responses = await standIn(box);
  let custody: ProcessCustody;
  try {
    custody = await startCustody({
      credentialsFile,
      destinations: [{ key: CHATGPT_PLAN_PROVIDER, origin: responses.origin }],
      plan: { tokenFile: dir.file, issuer: options.issuer ?? CHATGPT_PLAN_ISSUER },
    });
  } catch (error) {
    await responses.close();
    dir.done();
    throw error;
  }
  const pieces: string[] = [];
  const mapped = agentCustody({ credentialRef: 'ollama_key', planTokenFile: dir.file }, custody);
  return {
    custody,
    token: ACCESS,
    get sent() {
      return box.sent;
    },
    get reply() {
      return box.reply;
    },
    set reply(next) {
      box.reply = next;
    },
    pieces,
    agentCustody: mapped,
    dispatch: async (request) =>
      await mapped.dispatch(
        request,
        { deadlineAt: Date.now() + SEND_WINDOW_MS, onWritten: () => {} },
        (text) => pieces.push(text),
      ),
    close: async () => {
      await custody.stop();
      await responses.close();
      dir.done();
    },
  };
}
