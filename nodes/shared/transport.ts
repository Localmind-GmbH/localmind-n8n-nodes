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
import { NodeApiError, NodeOperationError, jsonParse } from 'n8n-workflow';

import { durationText, isCancelled, pause } from './polling';
import { errorCode, errorDetail } from './errors';
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
	 * Whether a 429 may be retried, or a check of its body that decides it. Localmind usually
	 * answers 429 before doing anything, but on `/chat/completions` up to 1.6.0 a graph agent can
	 * hit the rate limit after its first tools ran, so a retry would repeat their side effects
	 * (see `rateLimitedBeforeAction`). Defaults to true.
	 */
	retryRateLimited?: boolean | ((body: unknown) => boolean);
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

/** A stream that sent nothing for longer than allowed. */
export class StalledStream extends Error {}

/**
 * The next chunk of a stream, or a StalledStream error after `idleMs` without one. Once the chunk
 * is there, nothing refers to it from the timer any more: the listener goes, and Node frees an
 * unused timeout signal with its timer. (setTimeout is not open to community nodes, and n8n 2.41
 * has no sleepWithAbort.)
 */
async function nextWithin<T>(next: Promise<T>, idleMs: number): Promise<T> {
	const signal = AbortSignal.timeout(idleMs);
	return await new Promise<T>((resolve, reject) => {
		const onStall = () => reject(new StalledStream('No data'));
		signal.addEventListener('abort', onStall, { once: true });
		next.then(
			(value) => {
				signal.removeEventListener('abort', onStall);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener('abort', onStall);
				reject(error);
			},
		);
	});
}

/**
 * Reads a streamed body until it ends or `limit` bytes have arrived, whichever comes first, and
 * closes the stream on every way out, so the rest is never received. With `idleMs`, a stream that
 * sends nothing for that long fails. Takes a body that is already bytes as well.
 */
export async function readUpTo(body: unknown, limit: number, idleMs?: number): Promise<Buffer> {
	if (Buffer.isBuffer(body)) return body.subarray(0, limit);
	if (typeof body === 'string') return Buffer.from(body).subarray(0, limit);
	const stream = body as AsyncIterable<Buffer | Uint8Array | string> & { destroy?: () => void };
	const iterator = stream[Symbol.asyncIterator]();
	const chunks: Buffer[] = [];
	let size = 0;
	try {
		while (size < limit) {
			const next = idleMs ? await nextWithin(iterator.next(), idleMs) : await iterator.next();
			if (next.done) break;
			const chunk = next.value;
			const bytes =
				typeof chunk === 'string'
					? Buffer.from(chunk)
					: Buffer.isBuffer(chunk)
						? chunk
						: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
			chunks.push(bytes);
			size += bytes.length;
		}
	} finally {
		// Destroyed first: closing a stalled stream politely could wait as long as it stalls.
		stream.destroy?.();
		void iterator.return?.().catch(() => undefined);
	}
	return Buffer.concat(chunks, Math.min(size, limit));
}

async function readStream(body: unknown): Promise<string> {
	return (await readUpTo(body, MAX_ERROR_BODY_BYTES, 30_000)).toString('utf8');
}

/** The body of a failed response, decoded when it arrived as a stream or as bytes. */
async function errorBody(response: IN8nHttpFullResponse, streamed: boolean): Promise<unknown> {
	let text: string | undefined;
	try {
		const body: unknown = response.body;
		if (streamed && typeof body === 'object' && body !== null && Symbol.asyncIterator in body) {
			text = await readStream(body);
		} else if (Buffer.isBuffer(response.body)) {
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

/**
 * The longest a request may go without any data from Localmind, unless it sets its own timeout:
 * a server that accepts the connection and then says nothing would otherwise hold the node until
 * n8n's execution timeout, if there is one.
 */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/**
 * The timeout of requests that send a file (File → Upload, attachments): it also covers sending
 * the file, which over a slow link takes long.
 */
export const UPLOAD_TIMEOUT_MS = 60 * 60_000;

/** The longest a download may go without data once it has started. */
const DOWNLOAD_IDLE_MS = 5 * 60_000;

/** An error text with the API key masked, in case Localmind or a proxy echoes the request. */
function masked(text: string, apiKey: string | undefined): string {
	return apiKey && apiKey.length >= 8 ? text.split(apiKey).join('***') : text;
}

/** The error a node shows for a failed Localmind request: "Localmind: <detail>" plus the HTTP status. */
export function localmindError(
	node: INode,
	response: Pick<IN8nHttpFullResponse, 'statusCode' | 'statusMessage'>,
	body: unknown,
	baseUrl: string,
	itemIndex?: number,
	apiKey?: string,
): NodeApiError {
	const fullDetail = masked(
		errorDetail(body) ?? response.statusMessage ?? `HTTP ${response.statusCode}`,
		apiKey,
	);
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
	// For callers that explain a refusal by its stable code, such as an attachment's.
	const code =
		typeof body === 'object' && body !== null ? errorCode(body as JsonObject) : undefined;
	if (code) error.context.localmindCode = code;
	// Without a description of its own, n8n copies the API's detail into it, which the message
	// already carries ("Localmind: Agent not found … Agent not found").
	if (!description && error.description && error.message.includes(error.description)) {
		error.description = undefined;
	}
	return error;
}

/** What a timeout means for the request, and what to do next. */
function timeoutAdvice(request: LocalmindRequest, idempotent: boolean): string {
	if (request.path === '/chat/completions') {
		return 'The agent may still be working in Localmind. Localmind stops an answer of Agent → Ask or the Chat Model after 10 minutes; for longer tasks use Conversation → Send Message.';
	}
	if (!idempotent) {
		return 'Localmind may have received the request and carried it out all the same: check (for example with File → List or Get Messages) before sending it again, or it may happen twice.';
	}
	return 'Localmind did not answer in time. Check that it is running and reachable, then try again.';
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
	const { url, apiKey } = await this.getCredentials<LocalmindCredentials>(CREDENTIAL_TYPE);
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
		timeout: request.timeout ?? DEFAULT_TIMEOUT_MS,
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
			// Before the retry rule, which would repeat it four times. A read is tried once more:
			// one slow answer to a poll must not end a wait that has time left.
			if (isTimeoutError(error) && idempotent && attempt === 0) continue;
			if (isTimeoutError(error)) {
				// A new error: wrapping n8n's NodeApiError again would return it unchanged.
				throw new NodeApiError(
					this.getNode(),
					{ message: masked((error as Error).message, apiKey) },
					{
						message: `Localmind: no answer within ${durationText(request.timeout ?? DEFAULT_TIMEOUT_MS)}`,
						description: timeoutAdvice(request, idempotent),
						itemIndex: request.itemIndex,
					},
				);
			}
			// A dropped connection during a poll must not fail a turn that is already queued.
			if (idempotent && attempt < MAX_RETRIES && isTransientNetworkError(error)) {
				await pause(this, retryDelay(attempt));
				continue;
			}
			// Not the error itself: its cause still holds the request with the Authorization header.
			const { message, code } = error as { message?: string; code?: string };
			throw new NodeApiError(
				this.getNode(),
				{ message: masked(message ?? 'Network error', apiKey), ...(code && { code }) },
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
		const rateLimitRule = request.retryRateLimited ?? true;
		const retryRateLimited =
			typeof rateLimitRule === 'function' ? rateLimitRule(body) : rateLimitRule;
		if (attempt < MAX_RETRIES && isRetryable(response.statusCode, idempotent, retryRateLimited)) {
			await pause(this, retryDelay(attempt, parseRetryAfter(response.headers['retry-after'])));
			continue;
		}
		throw localmindError(this.getNode(), response, body, url, request.itemIndex, apiKey);
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

/**
 * Downloads a file from the API, for example a file an agent generated. It is received as a
 * stream that stops one byte past `maxBytes`, so a larger file never fills n8n's memory (n8n 2.16 to
 * 2.41 read a buffered response whole, whatever its size). A result longer than `maxBytes` means: too large.
 */
export async function localmindApiDownload(
	this: LocalmindContext,
	request: LocalmindRequest,
	maxBytes: number,
): Promise<{ data: Buffer; contentType?: string }> {
	const response = await send.call(this, request, { encoding: 'stream', json: false });
	const contentType = response.headers['content-type'];
	let data: Buffer;
	try {
		data = await readUpTo(response.body, maxBytes + 1, DOWNLOAD_IDLE_MS);
	} catch (error) {
		if (isCancelled(this))
			throw new NodeOperationError(this.getNode(), 'The execution was cancelled');
		// Not the error's own text: a stream error can carry the request, Authorization included.
		const code = (error as { code?: unknown }).code;
		const stalled = error instanceof StalledStream;
		// The code goes into the description: n8n replaces a message that names one.
		throw new NodeApiError(
			this.getNode(),
			{ message: 'The download broke off' },
			{
				message: stalled
					? `Localmind: the download sent no data for ${durationText(DOWNLOAD_IDLE_MS)}`
					: 'Localmind: the download broke off',
				description:
					!stalled && typeof code === 'string' && /^[A-Z_]+$/.test(code)
						? `The connection closed during the download (${code}). Try again.`
						: 'Try again.',
				itemIndex: request.itemIndex,
			},
		);
	}
	return { data, contentType: typeof contentType === 'string' ? contentType : undefined };
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
