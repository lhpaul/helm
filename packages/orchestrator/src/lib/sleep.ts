/** Injectable delay, so tests can advance the review loop without real waiting. */
export type SleepFn = (ms: number) => Promise<void>;

/** Real-time `SleepFn`; the default when a caller injects nothing. */
export const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
