// Helper for invoking a list of sync-or-async callbacks with error
// isolation. Each callback's error is swallowed so one bad listener can't
// kill the rest, and the function awaits every callback to settle before
// returning.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => void | Promise<void>;

export async function invokeCallbacksSafe(
  callbacks: AnyFn[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...args: any[]
): Promise<void> {
  await Promise.allSettled(callbacks.map((cb) => {
    try {
      return Promise.resolve(cb(...args));
    } catch (e) {
      return Promise.reject(e);
    }
  }));
}
