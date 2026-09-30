// SPDX-License-Identifier: AGPL-3.0-only
//
// The fake email provider (AW-07b): answers Resend's `POST /emails` on
// loopback, so CI and staging send mail through the broker and custody with
// no provider account. What it accepts it keeps in its outbox, the staging
// outbox that stands in for a person's mail. Its hostile modes are the
// answers a real provider can give: an oversized body, a redirect to an
// unlisted host, a malformed answer and one past the timeout.
//
// It is never loaded by custody; a test or the staging stack starts it.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EMAIL_NOTHING_HAPPENED } from './email.ts';

export type FakeEmailMode = 'accept' | 'refuse' | 'oversized' | 'redirect' | 'malformed' | 'slow';

/** One message as the provider received it. */
export interface OutboxMessage {
  readonly id: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

export interface FakeEmailProvider {
  readonly origin: string;
  /** Every request received, accepted or not. */
  readonly received: readonly OutboxMessage[];
  /** The messages accepted: the staging outbox. */
  readonly outbox: readonly OutboxMessage[];
  mode(next: FakeEmailMode): void;
  close(): Promise<void>;
}

async function readAll(request: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(part as Buffer);
  return Buffer.concat(parts).toString('utf8');
}

/** Start the fake on a loopback port of its own. */
export async function startFakeEmailProvider(): Promise<FakeEmailProvider> {
  let current: FakeEmailMode = 'accept';
  const received: OutboxMessage[] = [];
  const outbox: OutboxMessage[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const server: Server = createServer((request, response) => {
    void (async (): Promise<void> => {
      const message = {
        id: randomUUID(),
        authorization: request.headers['authorization'],
        body: await readAll(request),
      };
      received.push(message);
      const json = (status: number, body: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      switch (current) {
        case 'accept':
          outbox.push(message);
          return json(200, { id: message.id });
        case 'refuse':
          return json(422, { name: EMAIL_NOTHING_HAPPENED });
        case 'malformed':
          return json(200, { id: message.id, decision: 'approve', gate: randomUUID() });
        case 'redirect':
          response.writeHead(307, { location: 'http://203.0.113.9/emails' });
          response.end();
          return;
        case 'oversized':
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(`{"id":"${'x'.repeat(64 * 1024)}"}`);
          return;
        case 'slow': {
          const timer = setTimeout(() => {
            timers.delete(timer);
            json(200, { id: message.id });
          }, 10_000);
          timers.add(timer);
        }
      }
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    received,
    outbox,
    mode: (next) => {
      current = next;
    },
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
