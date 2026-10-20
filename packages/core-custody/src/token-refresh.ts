// SPDX-License-Identifier: AGPL-3.0-only
//
// One plan token refresh request (#1620 P1), with the stage it reached
// recorded. No header or body byte is handed to the socket before `carrying`:
// the request is ended only once the socket can carry (`connect` for http,
// `secureConnect` for https) and the absolute deadline, rechecked at that
// instant, has not passed. A failure or a lapse before it is `not_sent`. That
// judgement comes from the recorded stage, never an error code. No retry, no
// redirect, no shared agent.

import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import type { PlanTokens } from './token-file.ts';

export type RefreshStage = 'resolving' | 'connecting' | 'handshaking' | 'carrying' | 'answered';
export type RefreshResult =
  | { readonly kind: 'not_sent' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'answer'; readonly body: unknown }
  | { readonly kind: 'unknown' };
export const TOKEN_ANSWER_BYTES = 1_048_576;

/** The resource every plan token is for, as OpenAI's open-source flow and #1634 send it. */
const PLAN_RESOURCE = 'https://api.openai.com/v1';

/** The plan token issuer's one origin (#1704). */
export const PLAN_ISSUER_ORIGIN = 'https://auth.openai.com';

const bare = (url: URL): boolean => url.username === '' && url.password === '';

/** The plan issuer itself, with no credentials in the URL. */
export function planIssuer(url: URL): boolean {
  return url.origin === PLAN_ISSUER_ORIGIN && bare(url);
}

/** The plan issuer, or a 127.0.0.1 test issuer over `http:` or `https:`. */
export function issuerAllowed(url: URL): boolean {
  const loopback =
    (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname === '127.0.0.1';
  return planIssuer(url) || (loopback && bare(url));
}

/**
 * A private copy of an allowed token URL, judged after copying, so the
 * caller's later edit to its own URL cannot redirect the refresh.
 */
export function issuerCopy(url: URL): URL {
  const copy = new URL(url.href);
  if (!issuerAllowed(copy))
    throw new TypeError('the token URL is not the plan issuer or a 127.0.0.1 test issuer');
  return copy;
}

/** Classifies the issuer's answer, reading at most TOKEN_ANSWER_BYTES of a 200. */
function readAnswer(res: IncomingMessage, settle: (result: RefreshResult) => void): void {
  const status = res.statusCode ?? 0;
  if (status === 400 || status === 401) return settle({ kind: 'refused' });
  if (status !== 200) return settle({ kind: 'unknown' });
  const chunks: Buffer[] = [];
  let length = 0;
  res.on('data', (chunk: Buffer) => {
    length += chunk.length;
    if (length > TOKEN_ANSWER_BYTES) return settle({ kind: 'unknown' });
    chunks.push(chunk);
  });
  res.on('error', () => settle({ kind: 'unknown' }));
  res.on('aborted', () => settle({ kind: 'unknown' }));
  res.on('end', () => {
    if (!res.complete) return settle({ kind: 'unknown' });
    try {
      settle({
        kind: 'answer',
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
      });
    } catch {
      // The parse error quotes the answer; it is discarded.
      settle({ kind: 'unknown' });
    }
  });
}

/** Moves the stage on the socket's own events: `carrying` only once bytes can leave. */
function followStages(socket: Socket, tls: boolean, move: (stage: RefreshStage) => void): void {
  socket.once('connect', () => move(tls ? 'handshaking' : 'carrying'));
  if (tls) socket.once('secureConnect', () => move('carrying'));
}

/**
 * One request, never retried; the stage it reached decides `not_sent`.
 * `deadline` rechecks the prepare's absolute deadline on every call and
 * returns its signal, aborted once the deadline has passed.
 */
// oxlint-disable-next-line max-lines-per-function -- one request's stage, its single settlement and its three ways to end
export function refreshOnce(
  tokenUrl: URL,
  from: PlanTokens,
  deadline: () => AbortSignal,
  now: () => number = Date.now,
): Promise<{ readonly result: RefreshResult; readonly sentAt: number | undefined }> {
  const signal = deadline();
  if (!issuerAllowed(tokenUrl) || signal.aborted)
    return Promise.resolve({ result: { kind: 'not_sent' }, sentAt: undefined });
  const body = Buffer.from(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: from.refreshToken,
      client_id: from.clientId,
      resource: PLAN_RESOURCE,
    }).toString(),
  );
  const tls = tokenUrl.protocol === 'https:';
  let stage: RefreshStage = 'resolving';
  let sentAt: number | undefined;
  return new Promise((resolve) => {
    let req: ClientRequest | undefined;
    let settled = false;
    const settle = (result: RefreshResult): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      req?.destroy();
      resolve({ result, sentAt });
    };
    const failed = (): void =>
      settle(
        stage === 'carrying' || stage === 'answered' ? { kind: 'unknown' } : { kind: 'not_sent' },
      );
    const onAbort = (): void => failed();
    /** The only place request bytes are written: after the deadline is rechecked. */
    const carrying = (): void => {
      if (settled || deadline().aborted) return failed();
      sentAt = now();
      stage = 'carrying';
      req?.end(body);
    };
    const answered = (res: IncomingMessage): void => {
      stage = 'answered';
      readAnswer(res, settle);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    req = (tls ? httpsRequest : httpRequest)(
      tokenUrl,
      {
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': body.length,
        },
      },
      answered,
    );
    req.on('socket', (socket) => {
      stage = 'connecting';
      followStages(socket, tls, (next) => {
        if (next === 'carrying') carrying();
        else stage = next;
      });
    });
    req.on('error', failed);
  });
}
