// Tiny retry helper for the two network edges (the TTS endpoint and the
// Telegram Bot API). Exponential backoff; a shouldRetry predicate lets
// callers stop early on errors a retry can't fix.
export interface RetryOptions {
  attempts?: number; // total tries, including the first
  delayMs?: number; // doubled after each failed attempt
  shouldRetry?: (err: unknown) => boolean;
}

export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  { attempts = 3, delayMs = 2000, shouldRetry = () => true }: RetryOptions = {},
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !shouldRetry(err)) break;
      const wait = delayMs * 2 ** (attempt - 1);
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`${label} failed (attempt ${attempt}/${attempts}), retrying in ${wait / 1000}s: ${reason}`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw lastErr;
}
