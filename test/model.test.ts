import type { Message, StreamChunk, Tool } from '@n8n/ai-node-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
	LocalmindChatModel,
	OUTPUT_PARSER_TOOL,
	documentName,
	sniffMediaType,
	type ChatCompletionRequest,
	type ChatCompletionResponse,
} from '../nodes/LmChatLocalmind/model';
import { byteStream, node } from './helpers';

const AGENT_ID = '0b6f6c1e-8d1a-4c9e-9f3b-2a7d5e4c1b90';

const userMessage = (text: string): Message => ({
	role: 'user',
	content: [{ type: 'text', text }],
});

function modelAnswering(response: ChatCompletionResponse, ...sse: string[]) {
	const complete = vi.fn<(body: ChatCompletionRequest) => Promise<ChatCompletionResponse>>(
		async () => response,
	);
	const stream = vi.fn<(body: ChatCompletionRequest) => Promise<AsyncIterableIterator<Buffer>>>(
		async () => byteStream(...sse),
	);
	const model = new LocalmindChatModel(AGENT_ID, node, { complete, stream }, { temperature: 0.2 });
	return { model, complete, stream };
}

async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
	const result: StreamChunk[] = [];
	for await (const chunk of chunks) result.push(chunk);
	return result;
}

const sseChunk = (content: string | null, finishReason: string | null = null) =>
	`data: ${JSON.stringify({ id: 'c1', choices: [{ delta: { content }, finish_reason: finishReason }] })}\n\n`;

describe('LocalmindChatModel.generate', () => {
	it('sends the agent as model and maps the answer', async () => {
		const { model, complete } = modelAnswering({
			id: 'c1',
			choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
		});

		const result = await model.generate(
			[{ role: 'system', content: [{ type: 'text', text: 'Be brief.' }] }, userMessage('Hi')],
			{ maxTokens: 100 },
		);

		expect(complete).toHaveBeenCalledWith({
			model: AGENT_ID,
			messages: [
				{ role: 'system', content: 'Be brief.' },
				{ role: 'user', content: 'Hi' },
			],
			stream: false,
			temperature: 0.2,
			max_tokens: 100,
		});
		expect(result.message.content).toEqual([{ type: 'text', text: 'Hello!' }]);
		expect(result.finishReason).toBe('stop');
		expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
	});

	it('turns an "[Error: …]" answer into an error', async () => {
		const { model } = modelAnswering({
			choices: [{ message: { content: '[Error: Request timed out]' }, finish_reason: 'length' }],
		});

		await expect(model.generate([userMessage('Hi')])).rejects.toMatchObject({
			message: 'Localmind: Request timed out',
		});
	});

	it('fails when the agent stopped at its step limit', async () => {
		const { model } = modelAnswering({
			choices: [
				{
					message: {
						content:
							'The assistant paused after reaching the maximum number of steps (25) for a single run. Send another message (e.g. "continue") to resume the task.',
					},
					finish_reason: 'length',
				},
			],
		});

		await expect(model.generate([userMessage('Hi')])).rejects.toMatchObject({
			message: 'The agent stopped after reaching its maximum number of steps (25)',
		});
	});

	it('fails when all code sandboxes were busy', async () => {
		const busy = 'All compute resources are currently in use – please try again later.';
		const { model } = modelAnswering({
			choices: [{ message: { content: busy }, finish_reason: 'stop' }],
			notice: { code: 'sandbox_busy', message: busy },
		});

		await expect(model.generate([userMessage('Hi')])).rejects.toMatchObject({
			message: 'No code-execution slot was free, so the agent could not run its code',
		});
	});

	it('fails when the agent produced no text', async () => {
		const { model } = modelAnswering({
			choices: [{ message: { content: '' }, finish_reason: 'stop' }],
		});

		await expect(model.generate([userMessage('Hi')])).rejects.toMatchObject({
			message: 'The Localmind agent returned no answer',
		});
	});

	it('passes on an answer that repeats the previous one, as with a repeated greeting', async () => {
		const { model } = modelAnswering({
			choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
		});
		const history: Message[] = [
			userMessage('Hi'),
			{ role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
			userMessage('Hi again'),
		];

		const result = await model.generate(history);

		expect(result.message.content).toEqual([{ type: 'text', text: 'Hello!' }]);
	});

	it("asks for JSON in the output parser's shape and hands it over as the parser's tool call", async () => {
		const { model, complete } = modelAnswering({
			id: 'chatcmpl-1',
			choices: [{ message: { content: '```json\n{"output":{"name":"Ada"}}\n```' } }],
		});
		const parser: Tool = {
			type: 'function',
			name: OUTPUT_PARSER_TOOL,
			inputSchema: { type: 'object', properties: { output: { type: 'object' } } },
		};

		const result = await model
			.withTools([parser])
			.generate([
				{ role: 'system', content: [{ type: 'text', text: 'Be brief.' }] },
				userMessage('Hi'),
			]);

		// Appended to the question, not a message of its own: a graph agent's nodes take the last
		// message as their query.
		const messages = complete.mock.calls[0][0].messages;
		expect(messages).toEqual([
			{ role: 'system', content: 'Be brief.' },
			{
				role: 'user',
				content: expect.stringMatching(
					/^Hi\n\nRespond only with a JSON object that matches this JSON schema/,
				),
			},
		]);
		// n8n's AI Agent reads the parser's result from this call on every version (2.16 too).
		expect(result.finishReason).toBe('tool-calls');
		expect(result.message.content).toEqual([
			{
				type: 'tool-call',
				toolCallId: 'call_chatcmpl-1',
				toolName: OUTPUT_PARSER_TOOL,
				input: '{"output":{"name":"Ada"}}',
			},
		]);
	});

	it('wraps a bare JSON answer in "output", as n8n does for a text answer', async () => {
		const { model } = modelAnswering({
			choices: [{ message: { content: '{"name":"Ada","born":1815}' } }],
		});
		const parser: Tool = {
			type: 'function',
			name: OUTPUT_PARSER_TOOL,
			inputSchema: { type: 'object' },
		};

		const result = await model.withTools([parser]).generate([userMessage('Hi')]);

		expect(result.message.content).toEqual([
			expect.objectContaining({ input: '{"output":{"name":"Ada","born":1815}}' }),
		]);
	});

	it("replaces n8n's instruction to call the parser's tool, which a Localmind agent cannot", async () => {
		const { model, complete } = modelAnswering({
			choices: [{ message: { content: '{"output":{}}' } }],
		});
		const parser: Tool = {
			type: 'function',
			name: OUTPUT_PARSER_TOOL,
			inputSchema: { type: 'object' },
		};
		const n8nInstruction = `IMPORTANT: For your response to user, you MUST use the \`${OUTPUT_PARSER_TOOL}\` tool.`;

		await model
			.withTools([parser])
			.generate([
				{ role: 'system', content: [{ type: 'text', text: `Be brief.\n\n${n8nInstruction}` }] },
				userMessage('Hi'),
			]);

		const messages = complete.mock.calls[0][0].messages;
		expect(messages[0]).toEqual({ role: 'system', content: 'Be brief.' });
		expect(JSON.stringify(messages)).not.toContain('MUST use');
	});

	it('passes a non-JSON answer on as text for the output parser to report', async () => {
		const { model } = modelAnswering({
			choices: [{ message: { content: 'Ada Lovelace, 1815.' } }],
		});
		const parser: Tool = {
			type: 'function',
			name: OUTPUT_PARSER_TOOL,
			inputSchema: { type: 'object' },
		};

		const result = await model.withTools([parser]).generate([userMessage('Hi')]);

		expect(result.message.content).toEqual([{ type: 'text', text: 'Ada Lovelace, 1815.' }]);
	});

	it('refuses to run with n8n tools connected', async () => {
		const { model, complete } = modelAnswering({ choices: [] });
		const tool: Tool = { type: 'function', name: 'calculator', inputSchema: { type: 'object' } };

		await expect(model.withTools([tool]).generate([userMessage('Hi')])).rejects.toMatchObject({
			message: 'The Localmind Chat Model cannot use tools connected in n8n',
		});
		expect(complete).not.toHaveBeenCalled();
	});

	it('passes images as data URLs and documents as file blocks', async () => {
		const { model, complete } = modelAnswering({ choices: [{ message: { content: 'A cat.' } }] });

		await model.generate([
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'What is this?' },
					{ type: 'file', mediaType: 'image/png', data: 'aGVsbG8=' },
					{ type: 'file', mediaType: 'application/pdf', data: 'JVBERi0=' },
				],
			},
		]);

		expect(complete.mock.calls[0][0].messages[0]).toEqual({
			role: 'user',
			content: [
				{ type: 'text', text: 'What is this?' },
				{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
				{
					type: 'file',
					file: { filename: 'document.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' },
				},
			],
		});
	});

	it('recognises a PDF that n8n passes without a type', async () => {
		const { model, complete } = modelAnswering({ choices: [{ message: { content: 'Done.' } }] });
		const pdf = Buffer.from('%PDF-1.7 …').toString('base64');

		await model.generate([{ role: 'user', content: [{ type: 'file', data: pdf }] }]);

		expect(complete.mock.calls[0][0].messages[0].content).toEqual([
			{
				type: 'file',
				file: { filename: 'document.pdf', file_data: `data:application/pdf;base64,${pdf}` },
			},
		]);
	});

	it('refuses files Localmind cannot read', async () => {
		const { model } = modelAnswering({ choices: [] });

		await expect(
			model.generate([
				{ role: 'user', content: [{ type: 'file', mediaType: 'application/zip', data: 'x' }] },
			]),
		).rejects.toMatchObject({ message: expect.stringContaining('"application/zip"') });
	});
});

describe('LocalmindChatModel.stream', () => {
	it('yields text deltas and one finish chunk', async () => {
		const { model, stream } = modelAnswering(
			{},
			sseChunk('Hel'),
			sseChunk('lo'),
			sseChunk(null, 'stop'),
			`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })}\n\n`,
			'data: [DONE]\n\n',
		);

		const chunks = await collect(model.stream([userMessage('Hi')]));

		expect(stream.mock.calls[0][0]).toMatchObject({
			stream: true,
			stream_options: { include_usage: true },
			model: AGENT_ID,
		});
		expect(chunks).toEqual([
			{ type: 'text-delta', id: 'c1', delta: 'Hel' },
			{ type: 'text-delta', id: 'c1', delta: 'lo' },
			{
				type: 'finish',
				finishReason: 'stop',
				usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
			},
		]);
	});

	it('fails on an "[Error: …]" chunk after partial text', async () => {
		const { model } = modelAnswering(
			{},
			sseChunk('Working on it'),
			sseChunk('[Error: An internal error occurred]'),
			sseChunk(null, 'stop'),
			'data: [DONE]\n\n',
		);

		await expect(collect(model.stream([userMessage('Hi')]))).rejects.toMatchObject({
			message: 'Localmind: An internal error occurred',
		});
	});
});

describe('LocalmindChatModel.stream when all code sandboxes are busy', () => {
	it('fails on the notice in the last chunk, after the partial answer and the notice text', async () => {
		const busy = 'All compute resources are currently in use – please try again later.';
		const { model } = modelAnswering(
			{},
			sseChunk('Let me compute that:'),
			sseChunk(`\n\n${busy}`),
			`data: ${JSON.stringify({ id: 'c1', choices: [{ delta: {}, finish_reason: 'stop' }], notice: { code: 'sandbox_busy', message: busy } })}\n\n`,
			'data: [DONE]\n\n',
		);

		await expect(collect(model.stream([userMessage('Hi')]))).rejects.toMatchObject({
			message: 'No code-execution slot was free, so the agent could not run its code',
		});
	});
});

describe('LocalmindChatModel.stream when cut off', () => {
	it('fails on a stream without any text', async () => {
		const { model } = modelAnswering({}, sseChunk(null, 'stop'), 'data: [DONE]\n\n');

		await expect(collect(model.stream([userMessage('Hi')]))).rejects.toMatchObject({
			message: 'The Localmind agent returned no answer',
		});
	});

	it('does not report a stream without a finish reason as complete', async () => {
		const chunk = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hal' } }] })}\n\n`;
		const { model } = modelAnswering({}, chunk);

		const chunks = await collect(model.stream([userMessage('Hi')]));

		expect(chunks.at(-1)).toEqual({ type: 'finish', finishReason: 'other', usage: undefined });
	});
});

describe('sniffMediaType', () => {
	const base64 = (bytes: number[] | string) => Buffer.from(bytes as never).toString('base64');

	it('reads the type from a data URI or the first bytes', () => {
		expect(sniffMediaType('data:image/png;base64,AAAA')).toBe('image/png');
		expect(sniffMediaType(base64('%PDF-1.4'))).toBe('application/pdf');
		expect(sniffMediaType(base64([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
		expect(sniffMediaType(base64([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
		expect(sniffMediaType(base64('PK\u0003\u0004word/document.xml'))).toBe(
			'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		);
		expect(sniffMediaType(base64('plain text'))).toBeUndefined();
	});
});

describe('LocalmindChatModel with a chat memory', () => {
	it('skips tool results from earlier turns', async () => {
		const { model, complete } = modelAnswering({ choices: [{ message: { content: 'Hi.' } }] });

		await model.generate([
			{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', result: 'x' }] },
			userMessage('Hi'),
		]);

		expect(complete.mock.calls[0][0].messages).toEqual([{ role: 'user', content: 'Hi' }]);
	});
});

describe('LocalmindChatModel with an image n8n dropped', () => {
	it('leaves out the empty user message', async () => {
		const { model, complete } = modelAnswering({ choices: [{ message: { content: 'Hi.' } }] });

		await model.generate([userMessage('Describe the image'), { role: 'user', content: [] }]);

		expect(complete.mock.calls[0][0].messages).toEqual([
			{ role: 'user', content: 'Describe the image' },
		]);
	});

	it('explains when nothing of the message is left', async () => {
		const { model, complete } = modelAnswering({ choices: [] });

		await expect(model.generate([{ role: 'user', content: [] }])).rejects.toMatchObject({
			message: 'The message to the Localmind agent is empty',
		});
		expect(complete).not.toHaveBeenCalled();
	});
});

describe('documentName', () => {
	const file = (providerMetadata?: Record<string, unknown>) =>
		({ type: 'file', mediaType: 'application/pdf', data: 'x', providerMetadata }) as const;

	it('keeps the original name, adding the extension Localmind needs', () => {
		expect(documentName(file({ filename: 'invoice-2024.pdf' }), 'pdf')).toBe('invoice-2024.pdf');
		expect(documentName(file({ fileName: 'Contract' }), 'pdf')).toBe('Contract.pdf');
	});

	it('falls back to document.<ext> without a name', () => {
		expect(documentName(file(), 'pdf')).toBe('document.pdf');
	});
});

describe('LocalmindChatModel.stream with an output parser', () => {
	it('hands the answer over as text in one piece, not as a tool call', async () => {
		// When streaming, n8n's AI Agent (v3) ignores a call of the parser's tool and asks the model
		// again, up to ten full Localmind agent runs.
		const piece = (content: string) =>
			`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
		const { model, stream } = modelAnswering(
			{},
			piece('{"name":'),
			piece('"Ada"}'),
			'data: [DONE]\n\n',
		);
		const parser: Tool = {
			type: 'function',
			name: OUTPUT_PARSER_TOOL,
			inputSchema: { type: 'object' },
		};

		const chunks = await collect(model.withTools([parser]).stream([userMessage('Hi')]));

		expect(chunks.filter((chunk) => chunk.type === 'text-delta')).toEqual([
			expect.objectContaining({ delta: '{"name":"Ada"}' }),
		]);
		expect(chunks.some((chunk) => chunk.type === 'tool-call-delta')).toBe(false);
		expect(stream).toHaveBeenCalledTimes(1);
	});

	it('stops reading at [DONE], while Localmind may still hold the connection open', async () => {
		const { model } = modelAnswering(
			{},
			sseChunk('Hello', 'stop'),
			'data: [DONE]\n\n',
			sseChunk('after the end'),
		);

		const chunks = await collect(model.stream([userMessage('Hi')]));

		expect(chunks.filter((chunk) => chunk.type === 'text-delta')).toEqual([
			expect.objectContaining({ delta: 'Hello' }),
		]);
	});
});
