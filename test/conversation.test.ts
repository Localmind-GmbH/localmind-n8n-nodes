import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeConversation } from '../nodes/Localmind/resources/conversation/execute';
import { API, answer, idle, scriptedConversation } from './fakeConversation';
import { routedContext } from './helpers';

vi.mock('n8n-workflow', async (importOriginal) => ({
	...(await importOriginal<typeof import('n8n-workflow')>()),
	// The clock moves with every wait, so a polling loop that never ends times out instead.
	sleep: vi.fn(async (ms: number) => {
		vi.setSystemTime(Date.now() + ms);
	}),
}));

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
	vi.useRealTimers();
});

const TOOL_ID = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
const queuedTurn = { run_id: 'r1', user_message_id: 'u1', conversation_id: 'c1', status: 'QUEUED' };
const fileUrl = '/v1/storage/download/org-1/sandbox_outputs/1/c1/report.xlsx';

function sendMessageApi(answerMessage = answer()) {
	const conversation = scriptedConversation({ polls: [idle], messages: [answerMessage] });
	return (options: {
		method: string;
		url: string;
		qs?: Record<string, unknown>;
		body?: unknown;
	}) => {
		if (options.method === 'POST' && options.url === `${API}/conversations/c1/messages-async`) {
			return { statusCode: 202, body: queuedTurn };
		}
		if (options.url === `https://acme-api.example.com${fileUrl}`) {
			return {
				body: Buffer.from('xlsx'),
				headers: { 'content-type': 'application/octet-stream' },
			};
		}
		return conversation(options);
	};
}

const withFile = answer({
	metadata: {
		widgets: [
			{
				type: 'file_download',
				files: [
					{
						filename: 'report.xlsx',
						url: fileUrl,
						size: 4,
						content_type: 'application/octet-stream',
					},
				],
			},
		],
	},
});

describe('Conversation → Send Message', () => {
	it('sends attachments and disabled tools, waits, and returns the answer with its files', async () => {
		const { context, requests } = routedContext(
			sendMessageApi(withFile),
			{
				conversation: 'c1',
				message: 'Make a report',
				waitForAnswer: true,
				options: { attachments: 'notes', disabledToolIds: TOOL_ID },
			},
			{ notes: { mimeType: 'text/plain', fileName: 'notes.txt', data: 'Q3 numbers' } },
		);

		const [item] = await executeConversation.call(context, 'sendMessage', 0);

		expect(requests[0].body).toEqual({
			message: 'Make a report',
			attachments: [
				{ type: 'file', content: 'Q3 numbers', filename: 'notes.txt', media_type: 'text/plain' },
			],
			disabled_tool_ids: [TOOL_ID],
		});
		expect(item.json).toEqual({
			conversationId: 'c1',
			userMessageId: 'u1',
			runId: 'r1',
			messageId: 'a1',
			text: 'Report attached.',
			files: [
				{
					fileName: 'report.xlsx',
					size: 4,
					mimeType: undefined,
					url: fileUrl,
					binaryProperty: 'file_0',
				},
			],
			tokens: { prompt: 12, completion: 8, total: 20 },
		});
		expect(item.binary?.file_0).toMatchObject({ fileName: 'report.xlsx' });
		expect(context.helpers.prepareBinaryData).toHaveBeenCalledWith(
			Buffer.from('xlsx'),
			'report.xlsx',
			undefined,
		);
	});

	it('returns at once with the IDs when not waiting', async () => {
		const { context, requests } = routedContext(sendMessageApi(), {
			conversation: 'c1',
			message: 'Start the long job',
			waitForAnswer: false,
		});

		const [item] = await executeConversation.call(context, 'sendMessage', 0);

		expect(item.json).toEqual({
			conversationId: 'c1',
			userMessageId: 'u1',
			runId: 'r1',
			status: 'queued',
		});
		expect(requests).toHaveLength(1);
	});

	it('skips the download when switched off', async () => {
		const { context, requests } = routedContext(sendMessageApi(withFile), {
			conversation: 'c1',
			message: 'Make a report',
			options: { downloadFiles: false },
		});

		const [item] = await executeConversation.call(context, 'sendMessage', 0);

		expect(item.binary).toBeUndefined();
		expect(requests.map((r) => r.url)).not.toContain(`https://acme-api.example.com${fileUrl}`);
	});

	it('keeps the answer when a generated file cannot be downloaded', async () => {
		const api = sendMessageApi(withFile);
		const { context } = routedContext(
			(options) =>
				options.url.endsWith('/report.xlsx')
					? { statusCode: 404, body: { detail: 'Object not found' } }
					: api(options),
			{ conversation: 'c1', message: 'Make a report' },
		);

		const [item] = await executeConversation.call(context, 'sendMessage', 0);

		expect(item.json.text).toBe('Report attached.');
		expect(item.json.files).toEqual([
			expect.objectContaining({
				fileName: 'report.xlsx',
				errorMessage: 'Localmind: Object not found',
			}),
		]);
		expect(item.binary).toBeUndefined();
	});

	it('counts characters as Localmind does, so emoji count once', async () => {
		const { context } = routedContext(sendMessageApi(), {
			conversation: 'c1',
			message: '👍'.repeat(30_000),
			waitForAnswer: false,
		});

		const [item] = await executeConversation.call(context, 'sendMessage', 0);

		expect(item.json.status).toBe('queued');
	});

	it('turns a failed turn into an error with its code', async () => {
		// Localmind saves a failed turn's error as an empty message with the text in its metadata.
		const failed = answer({
			content: '',
			metadata: {
				error: true,
				error_message: 'The conversation is too long',
				code: 'context_overflow',
			},
		});
		const { context } = routedContext(sendMessageApi(failed), {
			conversation: 'c1',
			message: 'Hi',
		});

		await expect(executeConversation.call(context, 'sendMessage', 0)).rejects.toMatchObject({
			message: 'Localmind: The conversation is too long (context_overflow)',
		});
	});

	it('names conversation, message and run in errors after queuing', async () => {
		const paused = answer({ metadata: { widgets: [{ type: 'approval', status: 'pending' }] } });
		const { context } = routedContext(sendMessageApi(paused), {
			conversation: 'c1',
			message: 'Hi',
		});

		await expect(executeConversation.call(context, 'sendMessage', 0)).rejects.toMatchObject({
			description: expect.stringContaining('Conversation c1, message u1, run r1.'),
		});
	});

	it('refuses a message over 50,000 characters before sending', async () => {
		const { context, requests } = routedContext(sendMessageApi(), {
			conversation: 'c1',
			message: 'x'.repeat(50_001),
		});

		await expect(executeConversation.call(context, 'sendMessage', 0)).rejects.toMatchObject({
			message: 'The message has 50,001 characters; Localmind accepts at most 50,000',
		});
		expect(requests).toHaveLength(0);
	});

	it('refuses a tool ID that is not a UUID', async () => {
		const { context } = routedContext(sendMessageApi(), {
			conversation: 'c1',
			message: 'Hi',
			options: { disabledToolIds: 'web-search' },
		});

		await expect(executeConversation.call(context, 'sendMessage', 0)).rejects.toMatchObject({
			message: '"web-search" is not a tool ID',
		});
	});
});

describe('Conversation → other operations', () => {
	it('creates a conversation, leaving the title to Localmind when empty', async () => {
		const { context, requests } = routedContext(() => ({ statusCode: 201, body: { id: 'c1' } }), {
			agent: 'agent-1',
			space: 'space-1',
			title: '  ',
		});

		await executeConversation.call(context, 'create', 0);

		expect(requests[0]).toMatchObject({ method: 'POST', url: `${API}/conversations/` });
		expect(requests[0].body).toEqual({ agent_id: 'agent-1', space_id: 'space-1' });
	});

	it('lists conversations with filters, newest first', async () => {
		const { context, requests } = routedContext(
			() => ({
				body: { items: [{ id: 'c1' }], page: 1, total_pages: 1, total_items: 1, page_size: 50 },
			}),
			{
				returnAll: false,
				limit: 50,
				filters: { agentId: 'agent-1', title: 'invoice', search: 'Q3', includeSharedWithMe: true },
			},
		);

		const items = await executeConversation.call(context, 'getAll', 0);

		expect(items).toEqual([{ json: expect.objectContaining({ id: 'c1' }) }]);
		expect(requests[0]).toMatchObject({
			url: `${API}/conversations/search`,
			qs: { search: 'Q3', include_shared_with_me: true, page: 1, limit: 50 },
			body: {
				filters: { agent_id: 'agent-1', title__contains: 'invoice' },
				order_by: ['-last_message_at', 'id'],
			},
		});
	});

	it('returns simplified messages', async () => {
		const { context } = routedContext(
			() => ({ body: { messages: [{ id: 'u1', role: 'user', content: 'Hi' }, answer()] } }),
			{ conversation: 'c1', simplify: true },
		);

		const items = await executeConversation.call(context, 'getMessages', 0);

		expect(items.map((item) => item.json.text)).toEqual(['Hi', 'Report attached.']);
		expect(items[1].json.tokens).toEqual({ prompt: 12, completion: 8, total: 20 });
	});
});
