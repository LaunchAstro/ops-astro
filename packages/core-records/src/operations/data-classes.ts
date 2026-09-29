// SPDX-License-Identifier: AGPL-3.0-only
//
// The data-class register (C81): not built yet. The tests that name it are
// written first and fail on these stubs.

import type { TenantQuery } from '../tenancy/database.ts';

/** A class of personal information as it is set. */
export interface DataClass {
  readonly dataClass: string;
  readonly purpose: string;
  readonly disclosures: string;
  readonly retention: string;
  readonly deletion: string;
  readonly inUse: boolean;
}

/** A class as the privacy policy lists it. */
export type ListedDataClass = Omit<DataClass, 'inUse'>;

/** The classes in use, in the register's order, and their digest. */
export interface DataClassesState {
  readonly listed: readonly ListedDataClass[];
  readonly digest: string;
}

export function setDataClass(
  _tx: TenantQuery,
  _row: DataClass,
  _actorId: string,
): Promise<{ readonly id: string }> {
  return Promise.reject(new Error('data classes: not built yet'));
}

export function readDataClasses(_tx: TenantQuery): Promise<DataClassesState> {
  return Promise.reject(new Error('data classes: not built yet'));
}
