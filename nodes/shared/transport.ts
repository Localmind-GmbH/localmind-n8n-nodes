import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IN8nHttpFullResponse,
	INode,
	ISupplyDataFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, jsonParse } from 'n8n-workflow';

import { durationText, pause } from './polling';
import { errorDetail } from './errors';
import {
	MAX_RETRIES,
	isRetryable,
	isTimeoutError,
	isTransientNetworkError,
	parseRetryAfter,
	retryDelay,
} from './retry';
import { apiUrlForAppHost, isEncryptedOrLocalUrl, normalizeBaseUrl } from './url';

export const CREDENTIAL_TYPE = 'localmindApi';

export type LocalmindContext = IExecuteFunctions | ILoadOptionsFunctions | ISupplyDataFunctions;

export interface LocalmindCredentials {
	url: string;
	apiKey: string;
}

export interface LocalmindRequest {
	method: IHttpRequestMethods;
	/** Path below /v1, for example "/models". */
	path: string;
	/** A JSON body, or raw bytes (with a matching content-type header). */
	body?: IDataObject | Buffer;
	qs?: IDataObject;
	headers?: IDataObject;
	/**
	 * Whether sending the request twice is harmless, which allows retrying it after a 5xx.
	 * Defaults to true for every method except POST and PATCH; read-only POSTs such as the
	 * search endpoints set it explicitly.
	 */
	idempotent?: boolean;
	/**
	 * Whether a 429 may be retried. Localmind usually answers 429 before doing anything, but on
	 * `/chat/completions` a graph agent can hit the rate limit after its first tools ran, so a
	 * retry would repeat their side effects. Defaults to true.
	 */
	retryRateLimited?: boolean;
	/** Milliseconds to wait for the response. */
	timeout?: number;
	itemIndex?: number;
}

/** The envelope of the API's paginated `POST /v1/<resource>/search` endpoints. */
export interface Page<T> {
	items: T[];
	total_items: number;
	total_pages: number;
	page: number;
	page_size: number;
}

const MAX_PAGE_SIZE = 200;

/** 'Return All' reads at most this many pages, 200,000 results at the maximum page size. */
const MAX_PAGES = 1000;

/** An error answer is read up to this size; an error message never needs more. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

async function readStream(body: unknown): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of body as AsyncIterable<Buffer | string>) {
		const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
		chunks.push(bytes);
		size += bytes.length;
		// Leaving the loop closes the stream.
		if (size >= MAX_ERROR_BODY_BYTES) break;
	}
	return Buffer.concat(chunks).subarray(0, MAX_ERROR_BODY_BYTES).toString('utf8');
}

/** The body of a failed response, decoded when it arrived as a stream or as bytes. */
async function errorBody(response: IN8nHttpFullResponse, streamed: boolean): Promise<unknown> {
	let text: string | undefined;
	try {
		if (streamed) text = await readStream(response.body);
		else if (Buffer.isBuffer(response.body)) {
			text = response.body.subarray(0, MAX_ERROR_BODY_BYTES).toString('utf8');
		}
	} catch {
		// Reading failed, for example because the execution was stopped. That error still holds
		// the request with the Authorization header, so it is not passed on.
		return undefined;
	}
	return text === undefined ? response.body : jsonParse<unknown>(text, { fallbackValue: text });
}

/** At most this many characters of Localmind's error text reach the node's error. */
const MAX_DETAIL_LENGTH = 1000;

/** The error a node shows for a failed Localmind request: "Localmind: <detail>" plus the HTTP status. */
export function localmindError(
	node: INode,
	response: Pick<IN8nHttpFullResponse, 'statusCode' | 'statusMessage'>,
	body: unknown,
	baseUrl: string,
	itemIndex?: number,
): NodeApiError {
	const fullDetail = errorDetail(body) ?? response.statusMessage ?? `HTTP ${response.statusCode}`;
	const detail =
		fullDetail.length > MAX_DETAIL_LENGTH
			? `${fullDetail.slice(0, MAX_DETAIL_LENGTH)}…`
			: fullDetail;
	const apiUrl = response.statusCode === 404 ? apiUrlForAppHost(baseUrl) : undefined;
	// A flat summary, not the answer itself: n8n's error class searches the whole answer for a
	// message, and on a deeply nested one that blocks n8n for seconds to minutes (2.41 and later).
	const errorResponse: JsonObject = { message: detail };
	let description: string | undefined;
	if (apiUrl) {
		description = `The credential's API URL points to the Localmind app, which does not serve the API. Use the API host instead: ${apiUrl}`;
	}
	const error = new NodeApiError(node, errorResponse, {
		message: `Localmind: ${detail}`,
		description,
		httpCode: String(response.statusCode),
		itemIndex,
	});
	// Without a description of its own, n8n copies the API's detail into it, which the message
	// already carries ("Localmind: Agent not found … Agent not found").
	if (!description && error.description && error.message.includes(error.description)) {
		error.description = undefined;
	}
	return error;
}

async function send(
	this: LocalmindContext,
	request: LocalmindRequest,
	extra: Partial<IHttpRequestOptions> = {},
): Promise<IN8nHttpFullResponse> {
	// An ID of "." or ".." would collapse the path and reach another endpoint.
	if (
		request.path
			.split('?')[0]
			.split('/')
			.some((segment) => segment === '.' || segment === '..')
	) {
		throw new NodeApiError(
			this.getNode(),
			{ message: 'Invalid ID or path' },
			{
				message: 'Localmind: an ID or path is "." or ".."',
				description: 'Check the IDs and paths the node received.',
				itemIndex: request.itemIndex,
			},
		);
	}
	const { url } = await this.getCredentials<LocalmindCredentials>(CREDENTIAL_TYPE);
	// The credential already withholds the key from such a URL; this says why nothing works.
	if (!isEncryptedOrLocalUrl(url)) {
		throw new NodeApiError(
			this.getNode(),
			{ message: 'The API URL does not use https' },
			{
				message: 'Localmind: the API URL must use https',
				description:
					"Plain http would carry the API key and all data unencrypted, so it is allowed only for this machine (localhost, *.localhost, 127.0.0.1). Change the credential's API URL to an https:// address.",
				itemIndex: request.itemIndex,
			},
		);
	}
	const idempotent = request.idempotent ?? !['POST', 'PATCH'].includes(request.method);
	const streamed = extra.encoding === 'stream';
	// n8n drops an empty object body; endpoints that require a body would answer 422.
	const emptyJson =
		!Buffer.isBuffer(request.body) &&
		typeof request.body === 'object' &&
		Object.keys(request.body).length === 0;
	let options: IHttpRequestOptions = {
		method: request.method,
		url: `${normalizeBaseUrl(url)}/v1${request.path}`,
		qs: request.qs,
		body: emptyJson ? '{}' : request.body,
		headers: emptyJson
			? { ...request.headers, 'content-type': 'application/json' }
			: request.headers,
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		// n8n would send the API key along to whatever host a redirect points to; see below.
		disableFollowRedirect: true,
		...(request.timeout && { timeout: request.timeout }),
		...extra,
	};

	let redirects = 0;
	for (let attempt = 0; ; attempt++) {
		let response: IN8nHttpFullResponse;
		try {
			response = (await this.helpers.httpRequestWithAuthentication.call(
				this,
				CREDENTIAL_TYPE,
				options,
			)) as IN8nHttpFullResponse;
		} catch (error) {
			// A dropped connection during a poll must not fail a turn that is already queued.
			if (idempotent && attempt < MAX_RETRIES && isTransientNetworkError(error)) {
				await pause(this, retryDelay(attempt));
				continue;
			}
			if (request.timeout && isTimeoutError(error)) {
				// A new error: wrapping n8n's NodeApiError again would return it unchanged.
				throw new NodeApiError(
					this.getNode(),
					{ message: (error as Error).message },
					{
						message: `Localmind: no answer within ${durationText(request.timeout)}`,
						description:
							'The agent may still be working in Localmind. Localmind stops an answer of Agent → Ask or the Chat Model after 10 minutes; for longer tasks use Conversation → Send Message.',
						itemIndex: request.itemIndex,
					},
				);
			}
			// Not the error itself: its cause still holds the request with the Authorization header.
			const { message, code } = error as { message?: string; code?: string };
			throw new NodeApiError(
				this.getNode(),
				{ message: message ?? 'Network error', ...(code && { code }) },
				{ itemIndex: request.itemIndex },
			);
		}
		if (response.statusCode >= 300 && response.statusCode < 400) {
			// A redirected stream would otherwise stay open.
			(response.body as { destroy?: () => void } | undefined)?.destroy?.();
			const url = redirectTarget(this.getNode(), options.url, response, request.itemIndex);
			// The target URL already carries the query.
			options = { ...options, url, qs: undefined };
			if (++redirects > MAX_REDIRECTS) {
				throw new NodeApiError(
					this.getNode(),
					{ message: 'Too many redirects' },
					{ message: 'Localmind: too many redirects', itemIndex: request.itemIndex },
				);
			}
			attempt--;
			continue;
		}
		if (response.statusCode < 400) {
			// A proxy or the app host can answer with a web page and status 200; reading it as API
			// data would end in a confusing error or an empty list.
			if (!extra.encoding && typeof response.body === 'string' && /^\s*</.test(response.body)) {
				throw new NodeApiError(
					this.getNode(),
					{ message: 'The answer is a web page, not API data' },
					{
						message: 'Localmind: the answer is a web page, not API data',
						description:
							'Check the credential\'s API URL: it must be the Localmind API host ("-api"), not the app or a proxy page.',
						httpCode: String(response.statusCode),
						itemIndex: request.itemIndex,
					},
				);
			}
			return response;
		}
		// A retried DELETE whose first try worked but lost its answer finds nothing left to delete.
		if (request.method === 'DELETE' && attempt > 0 && response.statusCode === 404) {
			return { ...response, statusCode: 204, body: undefined };
		}

		const body = await errorBody(response, streamed);
		const retryRateLimited = request.retryRateLimited ?? true;
		if (attempt < MAX_RETRIES && isRetryable(response.statusCode, idempotent, retryRateLimited)) {
			await pause(this, retryDelay(attempt, parseRetryAfter(response.headers['retry-after'])));
			continue;
		}
		throw localmindError(this.getNode(), response, body, url, request.itemIndex);
	}
}

const MAX_REDIRECTS = 5;

/**
 * Where a redirect leads, followed only to the same origin (for example a trailing slash) or from
 * http to https on the same host: the request carries the API key, which must not go to another
 * host or port, nor travel unencrypted after a downgrade to http.
 */
function redirectTarget(
	node: INode,
	from: string,
	response: IN8nHttpFullResponse,
	itemIndex?: number,
): string {
	const location = response.headers.location;
	const target = typeof location === 'string' && location ? new URL(location, from) : undefined;
	const origin = new URL(from);
	const upgrade =
		origin.protocol === 'http:' &&
		target?.protocol === 'https:' &&
		target.hostname === origin.hostname &&
		target.port === '';
	if (target && (target.origin === origin.origin || upgrade)) return target.toString();
	throw new NodeApiError(
		node,
		{ message: `Redirected to ${target?.origin ?? 'an unknown address'}` },
		{
			message: `Localmind: the API address redirects to ${target?.origin ?? 'another address'}`,
			description:
				'The node follows redirects only to the same address or from http to https, so the API key is not sent anywhere else. Enter the address the redirect points to in the credential, if it is your Localmind API host.',
			itemIndex,
		},
	);
}

/**
 * Calls the Localmind API, retrying 429 (unless `retryRateLimited` is false) and, for repeatable
 * requests, 5xx answers and dropped connections with backoff.
 */
export async function localmindApiRequest<T>(
	this: LocalmindContext,
	request: LocalmindRequest,
): Promise<T> {
	const response = await send.call(this, request);
	return response.body as T;
}

/** Like {@link localmindApiRequest}, but returns the response body as a byte stream. */
export async function localmindApiStream(
	this: LocalmindContext,
	request: LocalmindRequest,
): Promise<AsyncIterableIterator<Buffer | Uint8Array>> {
	const response = await send.call(this, request, { encoding: 'stream' });
	return response.body as unknown as AsyncIterableIterator<Buffer | Uint8Array>;
}

/** Downloads a file from the API, for example a file an agent generated. */
export async function localmindApiDownload(
	this: LocalmindContext,
	request: LocalmindRequest,
	maxBytes?: number,
): Promise<{ data: Buffer; contentType?: string }> {
	const response = await send.call(this, request, {
		encoding: 'arraybuffer',
		json: false,
		// Honored by newer n8n; the caller checks the size afterwards as well.
		...(maxBytes !== undefined && { maxResponseBodyBytes: maxBytes }),
	});
	const contentType = response.headers['content-type'];
	return {
		// The body is a Buffer already; a copy would double the memory for large files.
		data: Buffer.isBuffer(response.body)
			? response.body
			: Buffer.from(response.body as ArrayBuffer),
		contentType: typeof contentType === 'string' ? contentType : undefined,
	};
}

/**
 * Collects the items of a paginated search endpoint, page by page, until `limit` items are
 * collected or the last page is reached.
 */
export async function localmindApiRequestAllItems<T>(
	this: LocalmindContext,
	request: LocalmindRequest,
	limit?: number,
): Promise<T[]> {
	const items: T[] = [];
	const pageSize = limit === undefined ? MAX_PAGE_SIZE : Math.min(limit, MAX_PAGE_SIZE);
	for (let page = 1; ; page++) {
		const result = (await localmindApiRequest.call(this, {
			...request,
			qs: { ...request.qs, page, limit: pageSize },
		})) as Page<T>;
		items.push(...result.items);
		if (limit !== undefined && items.length >= limit) return items.slice(0, limit);
		if (result.items.length === 0 || page >= result.total_pages) return items;
		// Return All trusts the page count Localmind reports; a wrong one must not fill the memory.
		if (page >= MAX_PAGES) {
			throw new NodeApiError(
				this.getNode(),
				{ message: 'Too many pages' },
				{
					message: `Localmind: more than ${MAX_PAGES * pageSize} results`,
					description:
						limit === undefined
							? "Turn off 'Return All' and set a 'Limit', or narrow the request."
							: "Set a lower 'Limit', or narrow the request.",
					itemIndex: request.itemIndex,
				},
			);
		}
	}
}
