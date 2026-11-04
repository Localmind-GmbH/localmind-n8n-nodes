import { NodeApiError, sleep, type JsonObject } from 'n8n-workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	localmindApiRequest,
	localmindApiRequestAllItems,
	localmindApiStream,
} from '../nodes/shared/transport';
import { byteStream, fakeContext, node } from './helpers';

vi.mock('n8n-workflow', async (importOriginal) => ({
	...(await importOriginal<typeof import('n8n-workflow')>()),
	sleep: vi.fn(async (ms: number) => {
		vi.setSystemTime(Date.now() + ms);
	}),
}));

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.mocked(sleep).mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

/** A network failure as httpRequestWithAuthentication throws it: wrapped in a NodeApiError. */
const networkError = (code: string, message: string) =>
	new NodeApiError(node, Object.assign(new Error(message), { code }) as unknown as JsonObject);

describe('localmindApiRequest', () => {
	it('calls the /v1 path of the normalized API URL with the credential', async () => {
		const { context, httpRequestWithAuthentication } = fakeContext([{ body: { data: [] } }]);

		const body = await localmindApiRequest.call(context, { method: 'GET', path: '/models' });

		expect(body).toEqual({ data: [] });
		expect(httpRequestWithAuthentication).toHaveBeenCalledWith(
			'localmindApi',
			expect.objectContaining({
				method: 'GET',
				url: 'https://acme-api.example.com/v1/models',
				json: true,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
			}),
		);
	});

	it('reports a web page answered with status 200 instead of reading it as data', async () => {
		const { context } = fakeContext([{ body: '<!doctype html><html><body>Login</body></html>' }]);

		await expect(
			localmindApiRequest.call(context, { method: 'GET', path: '/models' }),
		).rejects.toMatchObject({ message: 'Localmind: the answer is a web page, not API data' });
	});

	it('follows a redirect on the same host, such as a trailing slash', async () => {
		const { context, httpRequestWithAuthentication } = fakeContext([
			{ statusCode: 307, headers: { location: '/v1/conversations/?page=2' }, body: '' },
			{ body: { id: 'c1' } },
		]);

		const body = await localmindApiRequest.call(context, {
			method: 'GET',
			path: '/conversations',
			qs: { page: 2 },
		});

		expect(body).toEqual({ id: 'c1' });
		expect(httpRequestWithAuthentication.mock.calls[1][1]).toMatchObject({
			url: 'https://acme-api.example.com/v1/conversations/?page=2',
			disableFollowRedirect: true,
		});
		// The target URL already carries the query; sending qs too would repeat it.
		expect(httpRequestWithAuthentication.mock.calls[1][1].qs).toBeUndefined();
	});

	it.each([
		['another port', 'https://acme-api.example.com:8443/v1/models'],
		['a downgrade to http', 'http://acme-api.example.com/v1/models'],
	])('does not follow a redirect to %s', async (_case, location) => {
		const { context, httpRequestWithAuthentication } = fakeContext([
			{ statusCode: 301, headers: { location }, body: '' },
		]);

		await expect(
			localmindApiRequest.call(context, { method: 'GET', path: '/models' }),
		).rejects.toMatchObject({ message: expect.stringContaining('the API address redirects to') });
		expect(httpRequestWithAuthentication).toHaveBeenCalledTimes(1);
	});

	it('follows the upgrade from http to https on the same host', async () => {
		const { context, httpRequestWithAuthentication } = fakeContext(
			[
				{
					statusCode: 308,
					headers: { location: 'https://acme-api.example.com/v1/models' },
					body: '',
				},
				{ body: { data: [] } },
			],
			'http://acme-api.example.com',
		);

		await localmindApiRequest.call(context, { method: 'GET', path: '/models' });

		expect(httpRequestWithAuthentication.mock.calls[1][1].url).toBe(
			'https://acme-api.example.com/v1/models',
		);
	});

	it('gives up after too many redirects', async () => {
		const loop = { statusCode: 307, headers: { location: '/v1/models/' }, body: '' };
		const { context } = fakeContext(Array.from({ length: 10 }, () => loop));

		await expect(
			localmindApiRequest.call(context, { method: 'GET', path: '/models' }),
		).rejects.toMatchObject({ message: 'Localmind: too many redirects' });
	});

	it('does not send the API key to another host a redirect points to', async () => {
		const { context, httpRequestWithAuthentication } = fakeContext([
			{
				statusCode: 302,
				headers: { location: 'https://elsewhere.example.net/v1/models' },
				body: '',
			},
		]);

		await expect(
			localmindApiRequest.call(context, { method: 'GET', path: '/models' }),
		).rejects.toMatchObject({
			message: 'Localmind: the API address redirects to https://elsewhere.example.net',
		});
		expect(httpRequestWithAuthentication).toHaveBeenCalledTimes(1);
	});

	it('retries a 429 and waits as long as Retry-After says', async () => {
		const { context, httpRequestWithAuthentication } = fakeContext([
			{
				statusCode: 429,
				headers: { 'retry-after': '7' },
				body: { detail: 'Rate limit exceeded', error_code: 'RATE_LIMIT_EXCEEDED' },
			},
			{ body: { ok: true } },
		]);

		const body = await localmindApiRequest.call(context, {
			method: 'POST',
			path: '/conversations',
			body: {},
		});

		expect(body).toEqual({ ok: true });
		expect(httpRequestWithAuthentication).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(7_000);
	});

	it('stops waiting for a retry when the n8n execution is cancelled', async () => {
		const { context, httpRequestWithAuthentication } = fakeContext([
			{
				statusCode: 429,
				headers: { 'retry-after': '120' },
				body: { detail: 'Rate limit exceeded', error_code: 'RATE_LIMIT_EXCEEDED' },
			},
			{ body: { ok: true } },
		]);
		const controller = new AbortController();
		controller.abort();
		Object.assign(context, { getExecutionCancelSignal: () => controller.signal });

		await expect(
			localmindApiRequest.call(context, { method: 'GET', path: '/models' }),
		).rejects.toMatchObject({ message: 'The execution was cancelled' });
		expect(httpRequestWithAuthentication).toHaveBeenCalledTimes(1);
	});

	it('does not repeat a request after a 429 when asked not to', async () => {
		const { context, httpRequestWithAuthentication } = fakeContext([
			{
				statusCode: 429,
				headers: { 'retry-after': '60' },
				body: { detail: 'Rate limit exceeded', error_code: 'RATE_LIMIT_EXCEEDED' },
			},
		]);

		const request = localmindApiRequest.call(context, {
			method: 'POST',
			path: '/chat/completions',
			body: {},
			retryRateLimited: false,
		});

		await expect(request).rejects.toMatchObject({ httpCode: '429' });
		expect(httpRequestWithAuthentication).toHaveBeenCalledTimes(1);
	});

	it('sends an empty JSON body as "{}", which n8n would otherwise drop', async () => {
		const { context, httpRequestWithAuthentication } = fakeContext([{ body: {} }]);

		await localmindApiRequest.call(context, {
			method: 'POST',
			path: '/data/x/reprocess',
			body: {},
		});

		expect(httpRequestWithAuthentication.mock.calls[0][1]).toMatchObject({
			body: '{}',
			headers: { 'content-type': 'application/json' },
		});
	});

	it('says when a request with a timeout got no answer in time', async () => {
		const { context, httpRequestWithAuthentication } = fakeContext([]);
		httpRequestWithAuthentication.mockRejectedValueOnce(
			networkError('ECONNABORTED', 'timeout of 60000ms exceeded'),
		);

		const request = localmindApiRequest.call(context, {
			method: 'POST',
			path: '/chat/completions',
			body: { model: 'x' },
			timeout: 60_000,
		});

		await expect(request).rejects.toMatchObject({
			message: 'Localmind: no answer within 1 minute(s)',
		});
	});

	it('counts a 404 on a retried DELETE as done: the first try worked but lost its answer', async () => {
		const { context } = fakeContext([
			{ statusCode: 502, body: { detail: 'Bad Gateway' } },
			{ statusCode: 404, body: { detail: 'File not found: contracts/a.pdf' } },
		]);

		await expect(
			localmindApiRequest.call(context, { method: 'DELETE', path: '/spaces/s1/data/files' }),
		).resolves.toBeUndefined();
	});

	it('keeps a 404 on the first DELETE an error', async () => {
		const { context } = fakeContext([{ statusCode: 404, body: { detail: 'File not found' } }]);

		await expect(
			localmindApiRequest.call(context, { method: 'DELETE', path: '/spaces/s1/data/files' }),
		).rejects.toMatchObject({ message: 'Localmind: File not found' });
	});

	it('retries a 5xx for a GET until the retries run out, then fails', async () => {
		const failure = {
			statusCode: 503,
			statusMessage: 'Service Unavailable',
			body: '<html>…</html>',
		};
		const { context, httpRequestWithAuthentication } = fakeContext(Array(5).fill(failure));

		const request = localmindApiRequest.call(context, { method: 'GET', path: '/models' });

		await expect(request).rejects.toMatchObject({
			message: 'Localmind: Service Unavailable',
			httpCode: '503',
		});
		expect(httpRequestWithAuthentication).toHaveBeenCalledTimes(5);
		expect(sleep).toHaveBeenCalledTimes(4);
	});

	it('does not repeat a POST after a 5xx, so nothing is sent twice', async () => {
		const { context, httpRequestWithAuthentication } = fakeContext([
			{ statusCode: 502, body: { detail: 'Upstream failed' } },
		]);

		const request = localmindApiRequest.call(context, {
			method: 'POST',
			path: '/chat/completions',
			body: {},
		});

		await expect(request).rejects.toBeInstanceOf(NodeApiError);
		expect(httpRequestWithAuthentication).toHaveBeenCalledTimes(1);
	});

	it('retries a dropped connection for a GET', async () => {
		const { context, httpRequestWithAuthentication } = fakeContext([{ body: { data: [] } }]);
		httpRequestWithAuthentication.mockReset();
		httpRequestWithAuthentication
			.mockRejectedValueOnce(networkError('ECONNRESET', 'socket hang up'))
			.mockResolvedValueOnce({ statusCode: 200, headers: {}, body: { data: [] } });

		const body = await localmindApiRequest.call(context, { method: 'GET', path: '/models' });

		expect(body).toEqual({ data: [] });
		expect(httpRequestWithAuthentication).toHaveBeenCalledTimes(2);
	});

	it('does not repeat a POST after a dropped connection', async () => {
		const { context, httpRequestWithAuthentication } = fakeContext([]);
		httpRequestWithAuthentication.mockRejectedValueOnce(
			networkError('ECONNRESET', 'socket hang up'),
		);

		const request = localmindApiRequest.call(context, {
			method: 'POST',
			path: '/conversations/c1/messages-async',
			body: { message: 'Hi' },
		});

		await expect(request).rejects.toBeInstanceOf(NodeApiError);
		expect(httpRequestWithAuthentication).toHaveBeenCalledTimes(1);
	});

	it('repeats a read-only POST marked as idempotent', async () => {
		const { context, httpRequestWithAuthentication } = fakeContext([
			{ statusCode: 500, body: { detail: 'Oops' } },
			{ body: { items: [] } },
		]);

		await localmindApiRequest.call(context, {
			method: 'POST',
			path: '/spaces/search',
			body: {},
			idempotent: true,
		});

		expect(httpRequestWithAuthentication).toHaveBeenCalledTimes(2);
	});

	it('shows the Localmind detail and status', async () => {
		const { context } = fakeContext([{ statusCode: 404, body: { detail: 'Agent not found' } }]);

		const request = localmindApiRequest.call(context, { method: 'GET', path: '/agents/x' });

		await expect(request).rejects.toMatchObject({
			message: 'Localmind: Agent not found',
			httpCode: '404',
		});
	});

	it('points an -app host to the -api host', async () => {
		const { context } = fakeContext(
			[{ statusCode: 404, statusMessage: 'Not Found', body: '<!doctype html>' }],
			'https://acme-app.example.com',
		);

		const request = localmindApiRequest.call(context, { method: 'GET', path: '/models' });

		await expect(request).rejects.toMatchObject({
			description: expect.stringContaining('https://acme-api.example.com'),
		});
	});
});

describe('localmindApiStream', () => {
	it('returns the byte stream', async () => {
		const stream = byteStream('data: x\n\n');
		const { context, httpRequestWithAuthentication } = fakeContext([{ body: stream as never }]);

		const body = await localmindApiStream.call(context, {
			method: 'POST',
			path: '/chat/completions',
			body: {},
		});

		expect(body).toBe(stream);
		expect(httpRequestWithAuthentication.mock.calls[0][1]).toMatchObject({ encoding: 'stream' });
	});

	it('reads the error detail from a streamed error body', async () => {
		const { context } = fakeContext([
			{
				statusCode: 400,
				body: byteStream(
					'{"error":{"message":"Context too long",',
					'"code":"context_length_exceeded"}}',
				) as never,
			},
		]);

		const request = localmindApiStream.call(context, {
			method: 'POST',
			path: '/chat/completions',
			body: {},
		});

		await expect(request).rejects.toMatchObject({
			message: 'Localmind: Context too long (context_length_exceeded)',
		});
	});
});

describe('localmindApiRequestAllItems', () => {
	const page = (items: number[], pageNumber: number, totalPages: number) => ({
		body: { items, page: pageNumber, total_pages: totalPages, total_items: 0, page_size: 200 },
	});

	it('follows the pages to the end', async () => {
		const { context, httpRequestWithAuthentication } = fakeContext([
			page([1, 2], 1, 2),
			page([3], 2, 2),
		]);

		const items = await localmindApiRequestAllItems.call(context, {
			method: 'POST',
			path: '/spaces/search',
			body: {},
			idempotent: true,
		});

		expect(items).toEqual([1, 2, 3]);
		expect(httpRequestWithAuthentication.mock.calls[1][1].qs).toEqual({ page: 2, limit: 200 });
	});

	it('stops at the limit', async () => {
		const { context, httpRequestWithAuthentication } = fakeContext([page([1, 2, 3], 1, 5)]);

		const items = await localmindApiRequestAllItems.call(
			context,
			{ method: 'POST', path: '/spaces/search', body: {}, idempotent: true },
			3,
		);

		expect(items).toEqual([1, 2, 3]);
		expect(httpRequestWithAuthentication).toHaveBeenCalledTimes(1);
		expect(httpRequestWithAuthentication.mock.calls[0][1].qs).toEqual({ page: 1, limit: 3 });
	});
});
