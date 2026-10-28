// SPDX-License-Identifier: AGPL-3.0-only

/** `work`'s answer, or undefined once `ms` pass first. */
export async function withinDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: Parameters<typeof clearTimeout>[0];
  const late = new Promise<undefined>((done) => {
    timer = setTimeout(done, ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}
