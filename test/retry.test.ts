import { describe, expect, it } from 'vitest';

import { NodeApiError, type JsonObject } from 'n8n-workflow';

import {
	isRetryable,
	isTimeoutError,
	isTransientNetworkError,
	parseRetryAfter,
	retryDelay,
} from '../nodes/shared/retry';
import { node } from './helpers';

describe('isRetryable', () => {
	it('retries 429 unless asked not to', () => {
		expect(isRetryable(429, false)).toBe(true);
		expect(isRetryable(429, true)).toBe(true);
		expect(isRetryable(429, false, false)).toBe(false);
	});

	it('retries 5xx only for repeatable requests', () => {
		expect(isRetryable(502, true)).toBe(true);
		expect(isRetryable(503, true)).toBe(true);
		expect(isRetryable(502, false)).toBe(false);
	});

	it('does not retry other statuses', () => {
		expect(isRetryable(400, true)).toBe(false);
		expect(isRetryable(404, true)).toBe(false);
		expect(isRetryable(501, true)).toBe(false);
	});
});

describe('parseRetryAfter', () => {
	it('reads seconds', () => {
		expect(parseRetryAfter('60')).toBe(60_000);
		expect(parseRetryAfter(['5'])).toBe(5_000);
	});

	it('reads an HTTP date', () => {
		const now = Date.parse('2026-10-21T10:00:00Z');
		expect(parseRetryAfter('Wed, 21 Oct 2026 10:00:30 GMT', now)).toBe(30_000);
	});

	it('reads decimal seconds instead of taking them for a date', () => {
		expect(parseRetryAfter('1.5')).toBe(1_500);
	});

	it('ignores missing or unreadable values', () => {
		expect(parseRetryAfter(undefined)).toBeUndefined();
		expect(parseRetryAfter('soon')).toBeUndefined();
		expect(parseRetryAfter('1.5.2')).toBeUndefined();
	});
});

describe('retryDelay', () => {
	it('follows Retry-After, capped at two minutes', () => {
		expect(retryDelay(0, 60_000)).toBe(60_000);
		expect(retryDelay(0, 600_000)).toBe(120_000);
	});

	it('backs off exponentially with jitter', () => {
		expect(retryDelay(0, undefined, () => 0)).toBe(500);
		expect(retryDelay(0, undefined, () => 1)).toBe(1_000);
		expect(retryDelay(3, undefined, () => 1)).toBe(8_000);
		expect(retryDelay(10, undefined, () => 1)).toBe(30_000);
	});
});

describe('isTransientNetworkError', () => {
	it('recognises dropped connections and timeouts, also wrapped', () => {
		expect(isTransientNetworkError({ code: 'ECONNRESET' })).toBe(true);
		expect(isTransientNetworkError({ cause: { code: 'ETIMEDOUT' } })).toBe(true);
	});

	it('recognises them inside the NodeApiError n8n wraps them in', () => {
		const wrapped = new NodeApiError(
			node,
			Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) as unknown as JsonObject,
		);
		expect(isTransientNetworkError(wrapped)).toBe(true);
		expect(isTimeoutError(wrapped)).toBe(false);
	});

	it('tells timeouts apart', () => {
		expect(isTimeoutError({ code: 'ECONNABORTED' })).toBe(true);
		expect(isTimeoutError({ httpCode: 'ECONNABORTED' })).toBe(true);
		expect(isTimeoutError({ httpCode: 'ETIMEDOUT' })).toBe(false);
		expect(isTimeoutError({ httpCode: '504' })).toBe(false);
	});

	it('leaves other errors alone', () => {
		expect(isTransientNetworkError({ code: 'ENOTFOUND' })).toBe(false);
		expect(isTransientNetworkError(new Error('boom'))).toBe(false);
		expect(isTransientNetworkError(undefined)).toBe(false);
	});
});
