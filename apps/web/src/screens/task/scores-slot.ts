// SPDX-License-Identifier: AGPL-3.0-only
import { isRecord, isUuid, jsonSlot, type StorageLike } from '../../session/storage-slot.ts';

export type ScoreMark = 'impact' | 'confidence' | 'ease';
export interface ScoreAttempt {
  readonly operationId: string;
  readonly revision: number;
  readonly mark: ScoreMark;
  readonly value: number | null;
}
export interface ScoreEnvelope {
  readonly version: 1;
  readonly owner: string;
  readonly tasks: Readonly<Record<string, ScoreAttempt>>;
}
export const SCORE_KEY = 'ops-astro.task-scores';

export function isScoreMark(value: unknown): value is ScoreMark {
  return value === 'impact' || value === 'confidence' || value === 'ease';
}
export function isScoreValue(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10)
  );
}
function isAttempt(value: unknown): value is ScoreAttempt {
  return (
    isRecord(value) &&
    Object.keys(value).length === 4 &&
    Object.keys(value).every((key) => ['operationId', 'revision', 'mark', 'value'].includes(key)) &&
    isUuid(value['operationId']) &&
    Number.isSafeInteger(value['revision']) &&
    typeof value['revision'] === 'number' &&
    value['revision'] > 0 &&
    isScoreMark(value['mark']) &&
    isScoreValue(value['value'])
  );
}
function isEnvelope(value: unknown): value is ScoreEnvelope {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    Object.keys(value).every((key) => ['version', 'owner', 'tasks'].includes(key)) &&
    value['version'] === 1 &&
    typeof value['owner'] === 'string' &&
    isRecord(value['tasks']) &&
    !Array.isArray(value['tasks']) &&
    Object.entries(value['tasks']).every(([id, attempt]) => isUuid(id) && isAttempt(attempt))
  );
}
export const scoresSlot = (storage: StorageLike | null) => jsonSlot(storage, SCORE_KEY, isEnvelope);
