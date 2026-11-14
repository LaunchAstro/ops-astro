// SPDX-License-Identifier: AGPL-3.0-only
//
// Runs test bodies one after another, even when vitest has given up on one.
// A case past its timeout is failed but not stopped, so its body still runs.
// Each body starts only once every body handed in before it has ended (#2385).

/** A runner whose bodies run strictly in the order they were handed in. */
export function oneAtATime(): <T>(body: () => Promise<T>) => Promise<T> {
  let previous: Promise<unknown> = Promise.resolve();
  return <T>(body: () => Promise<T>): Promise<T> => {
    // The chain moves on before this body waits, so a body handed in later
    // always waits for this one, never only for the one before it.
    const turn = previous.then(body);
    previous = turn.then(
      () => null,
      () => null,
    );
    return turn;
  };
}
