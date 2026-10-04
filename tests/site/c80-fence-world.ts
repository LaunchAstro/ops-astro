// SPDX-License-Identifier: AGPL-3.0-only
//
// C80: the fence's test world, shared by the fence and encoding suites: a catalogued pool, a
// scripted resolver and transport, and a UTF-8 page answer.

import type {
  CapturePool,
  Resolver,
  Transport,
  TransportRequest,
} from '../../packages/core-connectors/src/index.ts';

export const ABOUT = 'https://www.example.com/about';
export const SERVICES = 'https://www.example.com/services';
export const PUBLIC_V4 = '93.184.215.14';

export const POOL: CapturePool = {
  agencyPages: [ABOUT, SERVICES],
  otherPages: ['https://client.example.org/'],
  closedPoolReviews: [],
};

export function resolverOf(...answers: string[][]): Resolver & { calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  const resolve = (host: string) => {
    calls.push(host);
    const answer = answers[Math.min(index, answers.length - 1)] ?? [];
    index += 1;
    return Promise.resolve(answer);
  };
  return Object.assign(resolve, { calls });
}

type Script = (request: TransportRequest) => Awaited<ReturnType<Transport>>;

export function transportOf(script: Script): Transport & { seen: TransportRequest[] } {
  const seen: TransportRequest[] = [];
  const transport = (request: TransportRequest) => {
    seen.push(request);
    return Promise.resolve(script(request));
  };
  return Object.assign(transport, { seen });
}

type PageAnswer = {
  kind: 'answer';
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
};

export const html = (body: string): PageAnswer => ({
  kind: 'answer',
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: new TextEncoder().encode(body),
});
