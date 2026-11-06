import type { IExecuteFunctions, IN8nHttpFullResponse, INode } from 'n8n-workflow';
import { vi } from 'vitest';

export const node: INode = {
	id: 'node-1',
	name: 'Localmind',
	type: '@localmind/n8n-nodes-localmind.localmind',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

/** An n8n execution context whose HTTP helper answers with the given responses in order. */
export function fakeContext(
	responses: Array<Partial<IN8nHttpFullResponse>>,
	url = 'https://acme-api.example.com/v1/',
) {
	const httpRequestWithAuthentication = vi.fn();
	for (const response of responses) {
		httpRequestWithAuthentication.mockResolvedValueOnce({
			statusCode: 200,
			headers: {},
			body: undefined,
			...response,
		});
	}
	const context = {
		getCredentials: vi.fn(async () => ({ url, apiKey: 'test-key' })),
		getNode: () => node,
		helpers: { httpRequestWithAuthentication },
	};
	return { context: context as unknown as IExecuteFunctions, httpRequestWithAuthentication };
}

/** A byte stream as n8n hands it over for `encoding: 'stream'`. */
export async function* byteStream(...chunks: string[]): AsyncIterableIterator<Buffer> {
	for (const chunk of chunks) yield Buffer.from(chunk);
}

type RequestOptions = {
	method: string;
	url: string;
	qs?: Record<string, unknown>;
	body?: unknown;
	headers?: Record<string, string>;
};
type Route = (options: RequestOptions) => Partial<IN8nHttpFullResponse> | undefined;

type BinaryInput = {
	mimeType: string;
	fileName?: string;
	fileExtension?: string;
	data: string | Buffer;
};

/**
 * An n8n execution context for whole operations: node parameters from `params`, binary input from
 * `binary`, and HTTP answers from `route`, which sees each request (method, full URL, qs, body).
 * A route may also throw, to simulate a failed connection.
 */
/** More requests than any test needs; the time-based simulations make about 1,500. */
const MAX_REQUESTS = 5_000;

export function routedContext(
	route: Route,
	params: Record<string, unknown> = {},
	binary: Record<string, BinaryInput> = {},
) {
	const requests: RequestOptions[] = [];
	const httpRequestWithAuthentication = vi.fn(async (_type: string, options: RequestOptions) => {
		requests.push(options);
		// A loop that never ends would hang the suite instead of failing the test.
		if (requests.length > MAX_REQUESTS) {
			throw new Error(`More than ${MAX_REQUESTS} requests: does a loop never end?`);
		}
		const response = route(options);
		if (!response) throw new Error(`Unexpected request ${options.method} ${options.url}`);
		return { statusCode: 200, headers: {}, ...response };
	});
	const context = {
		getCredentials: vi.fn(async () => ({
			url: 'https://acme-api.example.com',
			apiKey: 'test-key',
		})),
		getNode: () => node,
		getInputData: () => [{ json: {} }],
		continueOnFail: () => false,
		addExecutionHints: vi.fn(),
		getNodeParameter: (name: string, _itemIndex: number, fallback?: unknown) =>
			name in params ? params[name] : fallback,
		helpers: {
			httpRequestWithAuthentication,
			assertBinaryData: (_itemIndex: number, name: string) => {
				if (!binary[name]) throw new Error(`No binary field "${name}"`);
				const { mimeType, fileName, fileExtension } = binary[name];
				return { mimeType, fileName, fileExtension };
			},
			getBinaryDataBuffer: async (_itemIndex: number, name: string) =>
				Buffer.from(binary[name].data),
			prepareBinaryData: vi.fn(async (data: Buffer, fileName?: string, mimeType?: string) => ({
				data: data.toString('base64'),
				fileName,
				mimeType: mimeType ?? 'application/octet-stream',
			})),
		},
	};
	return { context: context as unknown as IExecuteFunctions, requests };
}
