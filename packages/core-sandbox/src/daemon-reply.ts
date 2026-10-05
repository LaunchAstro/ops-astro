// SPDX-License-Identifier: AGPL-3.0-only
import type { Result } from './refusal.ts';
export function readPing(_status: number, _body: Uint8Array): Result<object> {
  return { ok: true };
}
export function readNoContent(_status: number, _body: Uint8Array): Result<object> {
  return { ok: true };
}
export function readCreatedId(_body: Uint8Array): Result<{ id: string }> {
  return { ok: true, id: '' };
}
export function readWaitStatus(_body: Uint8Array): Result<{ statusCode: number }> {
  return { ok: true, statusCode: 0 };
}
export function readOomKilled(_body: Uint8Array): Result<{ oomKilled: boolean }> {
  return { ok: true, oomKilled: false };
}
export function readContainerIds(_body: Uint8Array): Result<{ ids: readonly string[] }> {
  return { ok: true, ids: [] };
}
export function readContainerCount(_body: Uint8Array): Result<{ containers: number }> {
  return { ok: true, containers: 0 };
}
