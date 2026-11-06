/** How often a failed request is repeated after the first try. */
export const MAX_RETRIES = 4;

const BASE_DELAY_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_RETRY_AFTER_MS = 120_000;

/**
 * Whether an answer with this status is worth repeating. A 429 usually is: the request was
 * turned away before it did anything (`retryRateLimited`). A 5xx only for requests that are safe
 * to repeat, so a message is never sent twice.
 */
export function isRetryable(
	statusCode: number,
	idempotent: boolean,
	retryRateLimited = true,
): boolean {
	if (statusCode === 429) return retryRateLimited;
	if (statusCode === 501 || statusCode === 505) return false;
	return idempotent && statusCode >= 500 && statusCode <= 599;
}

/**
 * Whether a 429 from `/chat/completions` came before the agent acted, so that a retry repeats
 * nothing. From Localmind 1.7.0 the endpoint answers a rate limit as an HTTP error only then, in
 * OpenAI's format (`{"error": {"type": "rate_limit_error"}}`), and reports later failures in the
 * answer. A text answer (a page from nginx or another proxy) never reached Localmind. Up to 1.6.0
 * Localmind answers `{"detail": …}`, possibly after a graph agent's first tools ran: not retried.
 */
export function rateLimitedBeforeAction(body: unknown): boolean {
	if (typeof body === 'string') return true;
	if (typeof body !== 'object' || body === null) return false;
	const { error } = body as { error?: unknown };
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { type?: unknown }).type === 'rate_limit_error'
	);
}

/** A Retry-After header (seconds or an HTTP date) in milliseconds, or undefined if absent or unreadable. */
export function parseRetryAfter(header: unknown, now: number = Date.now()): number | undefined {
	const raw = Array.isArray(header) ? header[0] : header;
	if (typeof raw === 'number') return raw >= 0 ? raw * 1000 : undefined;
	if (typeof raw !== 'string' || !raw.trim()) return undefined;
	const value = raw.trim();
	if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
	// Only an HTTP date has letters ("Wed, 21 Oct 2026 …"); V8 reads "1.5" as a date in 2001.
	if (!/[a-z]/i.test(value)) return undefined;
	const date = Date.parse(value);
	return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

const TRANSIENT_NETWORK_ERRORS = new Set([
	'ECONNRESET',
	'ECONNREFUSED',
	'ECONNABORTED',
	'ETIMEDOUT',
	'EPIPE',
	'EAI_AGAIN',
]);

// axios reports its own timeout as ECONNABORTED; ETIMEDOUT means the system could not connect.
const TIMEOUT_ERRORS = new Set(['ECONNABORTED']);

/**
 * The network error code (ECONNRESET, …) of a failed request. n8n wraps network failures in a
 * NodeApiError that keeps the code only in `httpCode`.
 */
function networkErrorCode(error: unknown): string | undefined {
	const failure = error as
		| { code?: unknown; httpCode?: unknown; cause?: { code?: unknown } }
		| undefined;
	const code = [failure?.code, failure?.cause?.code, failure?.httpCode].find(
		(value) => typeof value === 'string' && /^E[A-Z_]+$/.test(value),
	);
	return code as string | undefined;
}

/** Whether a request failed on the way (connection reset, timeout) rather than with an answer. */
export function isTransientNetworkError(error: unknown): boolean {
	const code = networkErrorCode(error);
	return code !== undefined && TRANSIENT_NETWORK_ERRORS.has(code);
}

/** Whether a request ran out of time waiting for the answer. */
export function isTimeoutError(error: unknown): boolean {
	const code = networkErrorCode(error);
	return code !== undefined && TIMEOUT_ERRORS.has(code);
}

/**
 * How long to wait before retry number `attempt` (0-based): the server's Retry-After when it
 * sent one, otherwise exponential backoff with jitter.
 */
export function retryDelay(
	attempt: number,
	retryAfterMs?: number,
	random: () => number = Math.random,
): number {
	if (retryAfterMs !== undefined) return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
	const backoff = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_BACKOFF_MS);
	return Math.round(backoff / 2 + random() * (backoff / 2));
}
