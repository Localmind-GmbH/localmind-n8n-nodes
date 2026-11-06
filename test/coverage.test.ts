import {
	sleep,
	Workflow,
	type IDataObject,
	type ILoadOptionsFunctions,
	type INode,
	type INodeExecutionData,
	type INodeProperties,
} from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { LocalmindApi } from '../credentials/LocalmindApi.credentials';
import { OUTPUT_PARSER_TOOL, LocalmindChatModel } from '../nodes/LmChatLocalmind/model';
import { askFiles } from '../nodes/Localmind/resources/agent/ask';
import { executeConversation } from '../nodes/Localmind/resources/conversation/execute';
import { generatedFiles } from '../nodes/Localmind/resources/conversation/messages';
import { mergeMetadata } from '../nodes/Localmind/resources/document/execute';
import { executeFile } from '../nodes/Localmind/resources/file/execute';
import { executeJob } from '../nodes/Localmind/resources/job/execute';
import {
	simplifyAgent,
	simplifyDocument,
	simplifyRun,
} from '../nodes/Localmind/resources/simplify';
import { executeSpace } from '../nodes/Localmind/resources/space';
import { stepLimitFromAnswer } from '../nodes/shared/errors';
import {
	attachGeneratedFiles,
	binaryPrefix,
	downloadSettings,
	safeMimeType,
} from '../nodes/shared/files';
import { parseJsonAnswer } from '../nodes/shared/json';
import { normalizeFolder } from '../nodes/shared/params';
import { durationText, pause } from '../nodes/shared/polling';
import { runError } from '../nodes/shared/runs';
import { searchSpaces } from '../nodes/shared/spaces';
import { localmindApiDownload, localmindApiRequestAllItems } from '../nodes/shared/transport';
import { API } from './fakeConversation';
import { fakeContext, node, routedContext } from './helpers';

describe('credential', () => {
	const credential = new LocalmindApi();

	it('tests against the models endpoint of the API host, without a trailing /v1', () => {
		expect(credential.test.request).toMatchObject({ url: '/v1/models' });
		expect(String(credential.test.request.baseURL)).toContain('.replace(/\\/v1$/i, "")');
	});

	it('names a wrong key and an app host in its test rules', () => {
		const messages = (credential.test.rules ?? []).map((rule) =>
			'properties' in rule ? String((rule.properties as { message?: string }).message) : '',
		);
		expect(messages.join(' ')).toContain('rejected the API key');
		expect(messages.join(' ')).toContain('-api');
	});

	it.each([
		['https://acme-api.example.com/v1/', 'Bearer sk-test', 'https://acme-api.example.com'],
		['http://dev-api.localhost', 'Bearer sk-test', 'http://dev-api.localhost'],
		['http://acme-api.example.com', '', 'https://plain-http-is-only-allowed-for-localhost.invalid'],
		['http://localhost@evil.com', '', 'https://plain-http-is-only-allowed-for-localhost.invalid'],
		['http://evil.com\\.localhost', '', 'https://plain-http-is-only-allowed-for-localhost.invalid'],
	])(
		"sends the key and tests only where allowed, in n8n's expression engine: %s",
		(url, header, testUrl) => {
			const workflow = new Workflow({
				nodes: [
					{
						id: '1',
						name: 'Test',
						type: 'n8n-nodes-base.noOp',
						typeVersion: 1,
						position: [0, 0],
						parameters: {},
					},
				],
				connections: {},
				active: false,
				nodeTypes: {
					getByName: () => ({ description: { properties: [] } }),
					getByNameAndVersion: () => ({ description: { properties: [] } }),
					getKnownTypes: () => ({}),
				} as never,
			});
			const resolve = (expression: string) =>
				workflow.expression.getParameterValue(expression, null, 0, 0, 'Test', [], 'internal', {
					$credentials: { url, apiKey: 'sk-test' },
				});

			expect(resolve(String(credential.authenticate.properties.headers?.Authorization))).toBe(
				header,
			);
			expect(resolve(String(credential.test.request.baseURL))).toBe(testUrl);
		},
	);

	it('keeps the API key in a password field', () => {
		const apiKey = credential.properties.find(
			(property: INodeProperties) => property.name === 'apiKey',
		);
		expect(apiKey?.typeOptions).toMatchObject({ password: true });
	});
});

describe('paging', () => {
	it('collects every page of a search until the last one', async () => {
		const { context, httpRequestWithAuthentication } = fakeContext([
			{ body: { items: [{ id: 1 }, { id: 2 }], total_pages: 2, page: 1 } },
			{ body: { items: [{ id: 3 }], total_pages: 2, page: 2 } },
		]);

		const items = await localmindApiRequestAllItems.call(context, {
			method: 'POST',
			path: '/spaces/search',
			body: { filters: {} },
			idempotent: true,
		});

		expect(items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
		expect(httpRequestWithAuthentication.mock.calls[1][1].qs).toMatchObject({ page: 2 });
	});

	it('stops at the limit', async () => {
		const { context, httpRequestWithAuthentication } = fakeContext([
			{ body: { items: [{ id: 1 }, { id: 2 }], total_pages: 5, page: 1 } },
		]);

		const items = await localmindApiRequestAllItems.call(
			context,
			{ method: 'POST', path: '/spaces/search', body: {}, idempotent: true },
			2,
		);

		expect(items).toHaveLength(2);
		expect(httpRequestWithAuthentication).toHaveBeenCalledTimes(1);
	});
});

describe('Space → Get Many', () => {
	it('searches spaces sorted by name, with a stable order', async () => {
		const { context, requests } = routedContext(
			() => ({ body: { items: [{ id: 's1', name: 'Sales' }], total_pages: 1 } }),
			{ returnAll: true },
		);

		const items = await executeSpace.call(context, 'getAll', 0);

		expect(items.map((item) => item.json.name)).toEqual(['Sales']);
		expect(requests[0]).toMatchObject({
			url: `${API}/spaces/search`,
			body: { filters: {}, order_by: ['name', 'id'] },
		});
	});
});

describe('File → Move or Rename and List', () => {
	it('renames with the old and the new path', async () => {
		const { context, requests } = routedContext(() => ({ body: { success: true } }), {
			space: 's1',
			path: '/contracts/offer.pdf',
			newPath: 'archive/offer.pdf',
		});

		await executeFile.call(context, 'move', 0);

		expect(requests[0]).toMatchObject({
			method: 'PATCH',
			url: `${API}/spaces/s1/data/rename`,
			body: { old_path: 'contracts/offer.pdf', new_path: 'archive/offer.pdf' },
		});
	});

	it('lists the files of a folder', async () => {
		const { context } = routedContext(
			() => ({
				body: {
					files: [
						{ path: 'contracts/offer.pdf', type: 'file', name: 'offer.pdf' },
						{ path: 'contracts/2024', type: 'folder', name: '2024' },
						{ path: 'contracts/2024/old.pdf', type: 'file', name: 'old.pdf' },
					],
				},
			}),
			{ space: 's1', folder: 'contracts', includeSubfolders: false },
		);

		const items = await executeFile.call(context, 'list', 0);

		expect(items.map((item) => item.json.path)).toEqual(['contracts/offer.pdf', 'contracts/2024']);
	});
});

describe('error bodies of downloads', () => {
	it('reads the detail from a binary error body', async () => {
		const { context } = fakeContext([
			{ statusCode: 404, body: Buffer.from(JSON.stringify({ detail: 'File not found' })) },
		]);

		await expect(
			localmindApiDownload.call(context, { method: 'GET', path: '/storage/download/x' }),
		).rejects.toMatchObject({ message: 'Localmind: File not found', httpCode: '404' });
	});
});

describe('cancelling an execution', () => {
	it('stops a pause that is already running', async () => {
		const controller = new AbortController();
		const context = { getNode: () => node, getExecutionCancelSignal: () => controller.signal };
		void sleep(10).then(() => controller.abort());

		await expect(pause(context, 5_000)).rejects.toMatchObject({
			message: 'The execution was cancelled',
		});
	});
});

describe('Localmind Chat Model stream', () => {
	it('reports a stream that breaks off', async () => {
		async function* broken() {
			yield Buffer.from(
				`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hal' } }] })}\n\n`,
			);
			throw new Error('aborted');
		}
		const model = new LocalmindChatModel('agent-1', node as INode, {
			complete: async () => ({}),
			stream: async () => broken(),
		});

		const read = async () => {
			const chunks: unknown[] = [];
			for await (const chunk of model.stream([
				{ role: 'user', content: [{ type: 'text', text: 'Hi' }] },
			])) {
				chunks.push(chunk);
			}
			return chunks;
		};

		await expect(read()).rejects.toMatchObject({
			message: 'The answer stream from Localmind broke off',
			description: expect.stringContaining('aborted'),
		});
	});

	it('names the parser tool n8n uses', () => {
		expect(OUTPUT_PARSER_TOOL).toBe('format_final_json_response');
	});
});

describe('error texts', () => {
	it('does not repeat the API detail as the description', async () => {
		const { context } = fakeContext([
			{ statusCode: 404, body: { detail: 'Agent not found', error_code: 'agent_not_found' } },
		]);

		const error = (await localmindApiDownload
			.call(context, { method: 'GET', path: '/models/x' })
			.catch((caught: unknown) => caught)) as { message: string; description?: string };

		expect(error.message).toBe('Localmind: Agent not found (agent_not_found)');
		expect(error.description).toBeUndefined();
	});

	it('names dot segments as the reason a download link is refused', async () => {
		const { context, requests } = routedContext(() => ({ body: '' }), {
			url: '/v1/storage/download/org-1/%2E%2E/conversations',
			binaryPropertyName: 'data',
		});

		await expect(executeFile.call(context, 'downloadByUrl', 0)).rejects.toMatchObject({
			message: expect.stringContaining('is refused'),
			description: expect.stringContaining('".." path segments'),
		});
		expect(requests).toHaveLength(0);
	});
});

describe('generated files', () => {
	it('names the binary fields with the chosen prefix', async () => {
		const { context } = routedContext(() => ({ body: Buffer.from('x') }));
		const item: INodeExecutionData = { json: {} };
		const file = {
			fileName: 'q3.xlsx',
			url: '/v1/storage/download/org-1/q3.xlsx',
			path: '/storage/download/org-1/q3.xlsx',
		};

		await attachGeneratedFiles.call(
			context,
			item,
			[file],
			{ download: true, prefix: binaryPrefix(' report_ '), maxFiles: 10, maxBytes: 1024 },
			0,
		);

		expect(Object.keys(item.binary ?? {})).toEqual(['report_0']);
		expect(binaryPrefix('')).toBe('file_');
	});

	it('does not follow a generated-file link with dot segments', async () => {
		const { context, requests } = routedContext(() => ({ body: Buffer.from('x') }));
		const item: INodeExecutionData = { json: {} };

		await attachGeneratedFiles.call(
			context,
			item,
			[
				{
					fileName: 'x.xlsx',
					url: '/v1/storage/download/org-1/../../conversations',
					path: '/storage/download/org-1/../../conversations',
				},
			],
			{ download: true, prefix: 'file_', maxFiles: 10, maxBytes: 1024 },
			0,
		);

		expect(requests).toHaveLength(0);
		expect(item.json.files).toEqual([
			expect.objectContaining({ errorMessage: expect.stringContaining('".." path segments') }),
		]);
	});
});

describe('Simplify', () => {
	it('reduces an agent to ten fields, with its tool IDs', () => {
		const agent = simplifyAgent({
			id: 'a1',
			name: 'Sales',
			agent_type: 'simple',
			tool_attachments: [{ tool_id: 't1', config: null }],
			system_prompt: 'long…',
			graph_config: {},
		});
		expect(Object.keys(agent)).toHaveLength(10);
		expect(agent).toMatchObject({ id: 'a1', agentType: 'simple', toolIds: ['t1'] });
		expect(agent).not.toHaveProperty('system_prompt');
	});

	it('gives a document its file-manager path, name and status', () => {
		const document = simplifyDocument({
			id: 'd1',
			space_id: 's1',
			file_path: 'spaces/s1/data/contracts/offer.pdf',
			processing_state: { pipeline_status: 'completed' },
		});
		expect(document).toMatchObject({
			name: 'offer.pdf',
			path: 'contracts/offer.pdf',
			status: 'completed',
			metadata: {},
		});
	});

	it('reports a file Localmind only stores as "stored", as File → Upload does', () => {
		const document = simplifyDocument({
			id: 'd2',
			space_id: 's1',
			file_path: 'spaces/s1/data/recordings/meeting.mp3',
			processing_state: { pipeline_status: 'stored_only' },
		});
		expect(document.status).toBe('stored');
	});

	it("names a failed run's error errorMessage, never error", () => {
		const run = simplifyRun({
			id: 'r1',
			status: 'FAILED',
			stages: [{ last_error: 'Parser crashed' }],
		});
		expect(run).toMatchObject({ runId: 'r1', finished: true, errorMessage: 'Parser crashed' });
		expect(run).not.toHaveProperty('error');
		expect(simplifyRun({ id: 'r2', status: 'RUNNING' })).not.toHaveProperty('errorMessage');
	});

	it('returns the raw conversation when Simplify is off', async () => {
		const raw = { id: 'c1', is_pinned: false, search_excerpt: null };
		const { context } = routedContext(() => ({ body: raw }), {
			conversation: 'c1',
			simplify: false,
		});

		const [item] = await executeConversation.call(context, 'get', 0);

		expect(item.json).toEqual(raw);
	});
});

describe('Space picker', () => {
	it('loads one page per call and offers the next one', async () => {
		const { context, requests } = routedContext(() => ({
			body: { items: [{ id: 's1', name: 'Sales' }], total_pages: 3, page: 1 },
		}));

		const result = await searchSpaces.call(context as unknown as ILoadOptionsFunctions, 'Sal');

		expect(result).toEqual({ results: [{ name: 'Sales', value: 's1' }], paginationToken: '2' });
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			qs: { page: 1, limit: 50 },
			body: { filters: { name__contains: 'Sal' } },
		});
	});
});

describe('answers shaped to slow n8n down', () => {
	it('parses fenced JSON as before', () => {
		expect(parseJsonAnswer('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
		expect(parseJsonAnswer('```JSON {"a": 1} ```')).toEqual({ a: 1 });
		expect(parseJsonAnswer('```\n[1, 2]\n```')).toEqual([1, 2]);
		expect(parseJsonAnswer('{"a": 1}')).toEqual({ a: 1 });
		expect(parseJsonAnswer('```')).toBeUndefined();
	});

	it('stays fast on a fence followed by a long run of whitespace', () => {
		const started = Date.now();
		parseJsonAnswer(`\`\`\`${' '.repeat(100_000)}`);
		parseJsonAnswer(`\`\`\`json${'\n'.repeat(100_000)}x`);
		expect(Date.now() - started).toBeLessThan(500);
	});

	it('stays fast on many step-limit openings', () => {
		const opening = 'The assistant paused after reaching the maximum number of steps (';
		const started = Date.now();
		expect(stepLimitFromAnswer(`${opening.repeat(5_000)}${'x'.repeat(100_000)}`)).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(500);
	});
});

describe('download limits for generated files', () => {
	const file = (name: string, size?: number) => ({
		fileName: name,
		size,
		url: `/v1/storage/download/org-1/${name}`,
		path: `/storage/download/org-1/${name}`,
	});
	const settings = { download: true, prefix: 'file_', maxFiles: 2, maxBytes: 10 };

	it('downloads at most the given number of files and lists the rest with a reason', async () => {
		const { context, requests } = routedContext(() => ({ body: Buffer.from('ok') }));
		const item: INodeExecutionData = { json: {} };

		await attachGeneratedFiles.call(context, item, [file('a'), file('b'), file('c')], settings, 0);

		expect(requests).toHaveLength(2);
		expect(Object.keys(item.binary ?? {})).toEqual(['file_0', 'file_1']);
		expect((item.json.files as IDataObject[])[2]).toMatchObject({
			url: '/v1/storage/download/org-1/c',
			errorMessage: expect.stringContaining("'Max Files to Download'"),
		});
	});

	it('skips a file Localmind reports as too large without downloading it', async () => {
		const { context, requests } = routedContext(() => ({ body: Buffer.from('ok') }));
		const item: INodeExecutionData = { json: {} };

		await attachGeneratedFiles.call(context, item, [file('big', 11)], settings, 0);

		expect(requests).toHaveLength(0);
		expect((item.json.files as IDataObject[])[0].errorMessage).toContain("'Max File Size (MB)'");
	});

	it('drops a download that turns out larger than the limit', async () => {
		const { context } = routedContext(() => ({ body: Buffer.from('more than ten bytes') }));
		const item: INodeExecutionData = { json: {} };

		await attachGeneratedFiles.call(context, item, [file('a')], settings, 0);

		expect(item.binary).toBeUndefined();
		expect((item.json.files as IDataObject[])[0].errorMessage).toContain('larger than');
	});

	it('does not download in tool mode unless switched on', () => {
		const tool = {
			getNode: () => ({ ...node, type: '@localmind/n8n-nodes-localmind.localmindTool' }),
		};
		const regular = { getNode: () => node };

		expect(downloadSettings.call(tool as never, {}).download).toBe(false);
		expect(downloadSettings.call(tool as never, { downloadFiles: true }).download).toBe(true);
		expect(downloadSettings.call(regular as never, {})).toMatchObject({
			download: true,
			maxFiles: 10,
			maxBytes: 50 * 1024 * 1024,
		});
	});
});

describe('hardening against odd input', () => {
	it('keeps a MIME type with line breaks out of the multipart header', () => {
		expect(safeMimeType('application/pdf')).toBe('application/pdf');
		expect(safeMimeType('text/plain; charset=utf-8')).toBe('text/plain; charset=utf-8');
		expect(safeMimeType('text/plain\r\nX-Injected: 1')).toBe('application/octet-stream');
	});

	it('normalizes folders quickly and without stray spaces', () => {
		expect(normalizeFolder('/ docs/ ')).toBe('docs');
		expect(normalizeFolder(' /contracts/2024/ ')).toBe('contracts/2024');
		const started = Date.now();
		normalizeFolder(`${'/'.repeat(100_000)}x${'/'.repeat(100_000)}`);
		expect(Date.now() - started).toBeLessThan(500);
	});

	it('skips malformed generated-file entries instead of failing', () => {
		const message = {
			role: 'assistant',
			content: '',
			metadata: {
				widgets: [
					{ type: 'file_download', files: [null, { url: '/v1/storage/download/o/a.xlsx' }] },
				],
			},
		};
		expect(generatedFiles(message).map((file) => file.url)).toEqual([
			'/v1/storage/download/o/a.xlsx',
		]);
	});

	it('merges a "__proto__" key as a field and keeps Localmind\'s own fields', () => {
		const update = JSON.parse(
			'{"__proto__": {"polluted": true}, "original_filename": "x", "project": "Q3"}',
		);
		const merged = mergeMetadata({ original_filename: 'offer.pdf' }, update);
		expect(Object.keys(merged)).toEqual(['original_filename', '__proto__', 'project']);
		expect(merged.original_filename).toBe('offer.pdf');
		expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
	});

	it('refuses an ID of ".." before sending anything', async () => {
		const { context, requests } = routedContext(() => ({ body: {} }), {
			resource: 'conversation',
			conversation: '..',
		});

		await expect(executeConversation.call(context, 'get', 0)).rejects.toMatchObject({
			message: 'Localmind: an ID or path is "." or ".."',
		});
		expect(requests).toHaveLength(0);
	});

	it('refuses a very long message without counting it character by character', async () => {
		const { context, requests } = routedContext(() => ({ body: {} }), {
			conversation: 'c1',
			message: 'x'.repeat(2_000_000),
			waitForAnswer: false,
			options: {},
		});

		await expect(executeConversation.call(context, 'sendMessage', 0)).rejects.toMatchObject({
			message: expect.stringContaining('Localmind accepts at most 50,000'),
		});
		expect(requests).toHaveLength(0);
	});
});

describe('malformed API data', () => {
	it('does not fail on null entries in files, stages or tools', () => {
		expect(
			askFiles({ attachments: [null as never, { url: '/v1/storage/download/o/a.pdf' }] }),
		).toHaveLength(1);
		expect(runError({ status: 'FAILED', stages: [null as never, { last_error: 'Boom' }] })).toBe(
			'Boom',
		);
		expect(
			simplifyAgent({ id: 'a1', tool_attachments: [null, { tool_id: 't1' }] }).toolIds,
		).toEqual(['t1']);
	});
});

describe('Localmind Chat Model connection and images', () => {
	it('closes the stream after [DONE], although Localmind keeps it open', async () => {
		let closed = false;
		async function* open() {
			try {
				yield Buffer.from(
					`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
				);
				// Localmind would keep the connection open here while it cleans up.
				await new Promise(() => undefined);
			} finally {
				closed = true;
			}
		}
		const model = new LocalmindChatModel('agent-1', node as INode, {
			complete: async () => ({}),
			stream: async () => open(),
		});

		const chunks: unknown[] = [];
		for await (const chunk of model.stream([
			{ role: 'user', content: [{ type: 'text', text: 'Hi' }] },
		])) {
			chunks.push(chunk);
		}

		expect(chunks.length).toBeGreaterThan(0);
		expect(closed).toBe(true);
	});

	it('refuses an image type Localmind does not accept', async () => {
		const model = new LocalmindChatModel('agent-1', node as INode, {
			complete: async () => ({ choices: [{ message: { content: 'x' } }] }),
			stream: async () => (async function* () {})(),
		});
		const tiff = { type: 'file' as const, data: 'AAAA', mediaType: 'image/tiff' };

		await expect(
			model.generate([{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, tiff] }]),
		).rejects.toMatchObject({
			message: 'The Localmind Chat Model cannot pass "image/tiff" images',
		});
	});
});

describe('timeouts in words', () => {
	it('says seconds below a minute instead of "0 minute(s)"', () => {
		expect(durationText(15_000)).toBe('15 second(s)');
		expect(durationText(90_000)).toBe('2 minute(s)');
		expect(durationText(15 * 60_000)).toBe('15 minute(s)');
	});

	it('does not check the timeout of Job → Get when it does not wait', async () => {
		const { context } = routedContext(() => ({ body: { id: 'r1', status: 'RUNNING' } }), {
			runId: 'r1',
			options: { waitUntilFinished: false, timeoutMinutes: 'soon' },
		});

		await expect(executeJob.call(context, 'get', 0)).resolves.toHaveLength(1);
	});
});
