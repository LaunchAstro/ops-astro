// SPDX-License-Identifier: AGPL-3.0-only
/** The entries shown before the fold (CS-4.31). */
export const LATEST_TIME_ENTRIES = 3;

/** "5m", "1h", "1h 30m". */
export function minutesText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${String(rest)}m`;
  return rest === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(rest)}m`;
}

/** How far the total has burned into the estimate; danger only past it. None without one. */
export function burnOf(
  totalMinutes: number,
  estimateMinutes: number | null,
): { readonly percent: number; readonly danger: boolean } | null {
  if (estimateMinutes === null || estimateMinutes <= 0) return null;
  const percent = Math.min(100, Math.round((totalMinutes / estimateMinutes) * 100));
  return { percent, danger: totalMinutes > estimateMinutes };
}
