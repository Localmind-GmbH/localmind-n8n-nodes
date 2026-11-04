import type { INode } from 'n8n-workflow';
import { NodeApiError, NodeOperationError, jsonParse } from 'n8n-workflow';
import {
	BaseChatModel,
	getParametersJsonSchema,
	parseSSEStream,
	type ChatModelConfig,
	type ContentFile,
	type ContentToolCall,
	type FinishReason,
	type GenerateResult,
	type Message,
	type StreamChunk,
	type TokenUsage,
	type Tool,
} from '@n8n/ai-node-sdk';

import {
	SANDBOX_BUSY_MESSAGE,
	agentErrorFromAnswer,
	isSandboxBusy,
	stepLimitFromAnswer,
	stepLimitMessage,
} from '../shared/errors';
import { isAcceptedImage } from '../shared/files';
import { parseJsonAnswer } from '../shared/json';

type ChatContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } }
	| { type: 'file'; file: { filename: string; file_data: string } };

interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string | ChatContentPart[];
}

export interface ChatCompletionRequest {
	model: string;
	messages: ChatMessage[];
	stream: boolean;
	stream_options?: { include_usage: boolean };
	temperature?: number;
	max_tokens?: number;
}

interface ChatUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
}

export interface ChatCompletionResponse {
	id?: string;
	choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
	usage?: ChatUsage | null;
	/** From Localmind 1.6.0: why the request ended without the agent's answer. */
	notice?: { code?: string; message?: string } | null;
}

interface ChatCompletionChunk {
	id?: string;
	choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
	usage?: ChatUsage | null;
	/** On the last chunk: the busy notice, after the notice's text came as the last delta. */
	notice?: { code?: string; message?: string } | null;
}

/** How the model reaches the API. The node supplies these, so requests use its credential, retries and errors. */
export interface LocalmindChatRequests {
	complete(body: ChatCompletionRequest): Promise<ChatCompletionResponse>;
	stream(body: ChatCompletionRequest): Promise<AsyncIterableIterator<Buffer | Uint8Array>>;
}

/** The tool n8n's AI Agent adds for an output parser ("Require Specific Output Format"). */
export const OUTPUT_PARSER_TOOL = 'format_final_json_response';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

// Localmind detects a document's type from its file name; n8n passes files without one.
const DOCUMENT_EXTENSIONS: Record<string, string> = {
	'application/pdf': 'pdf',
	[DOCX]: 'docx',
	[XLSX]: 'xlsx',
	[PPTX]: 'pptx',
	'text/plain': 'txt',
	'text/markdown': 'md',
	'text/csv': 'csv',
};

function finishReason(reason?: string | null): FinishReason {
	switch (reason) {
		case 'stop':
			return 'stop';
		case 'length':
			return 'length';
		case 'content_filter':
			return 'content-filter';
		case 'tool_calls':
			return 'tool-calls';
		default:
			return 'other';
	}
}

function tokenUsage(usage?: ChatUsage | null): TokenUsage | undefined {
	if (!usage) return undefined;
	return {
		promptTokens: usage.prompt_tokens ?? 0,
		completionTokens: usage.completion_tokens ?? 0,
		totalTokens: usage.total_tokens ?? 0,
	};
}

function fileBytes(data: string | Uint8Array): Buffer {
	return typeof data === 'string'
		? Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64')
		: Buffer.from(data);
}

/**
 * The MIME type of file data that arrived without one, from its data URI or its first bytes.
 * n8n's AI Agent passes PDFs in a shape the SDK converts without a type.
 */
export function sniffMediaType(data: string | Uint8Array): string | undefined {
	if (typeof data === 'string') {
		const dataUri = /^data:([^;,]+)[;,]/i.exec(data);
		if (dataUri) return dataUri[1].toLowerCase();
	}
	const bytes = fileBytes(data);
	const ascii = (start: number, end: number) => bytes.subarray(start, end).toString('latin1');
	if (ascii(0, 4) === '%PDF') return 'application/pdf';
	if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
	if (ascii(0, 4) === 'GIF8') return 'image/gif';
	if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
	if (ascii(0, 2) === 'PK') {
		// Office documents are zip files; their part names tell them apart.
		const names = bytes.toString('latin1');
		if (names.includes('word/')) return DOCX;
		if (names.includes('xl/')) return XLSX;
		if (names.includes('ppt/')) return PPTX;
	}
	return undefined;
}

/**
 * The name to send a document under: its original name when n8n passes one, with the extension
 * Localmind needs to tell its type, else "document.<ext>".
 */
export function documentName(file: ContentFile, extension: string): string {
	const metadata = file.providerMetadata ?? {};
	const original = [metadata.filename, metadata.fileName, metadata.name].find(
		(value): value is string => typeof value === 'string' && value.trim() !== '',
	);
	if (!original) return `document.${extension}`;
	const name = original.trim().split(/[\\/]/).pop() as string;
	return name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`;
}

function dataUrl(data: string | Uint8Array, mediaType: string): string {
	if (typeof data === 'string' && /^(data:|https?:)/i.test(data)) return data;
	return `data:${mediaType};base64,${fileBytes(data).toString('base64')}`;
}

/** An instruction to answer in the shape the AI Agent's output parser expects. */
function outputFormatInstruction(tool: Tool): string {
	const schema = tool.type === 'function' ? JSON.stringify(getParametersJsonSchema(tool)) : '';
	return schema
		? `Respond only with a JSON object that matches this JSON schema: ${schema}`
		: 'Respond only with a JSON object.';
}

/** Ends reading a response stream and releases its connection; errors while closing are ignored. */
async function closeStream(
	events: AsyncIterator<unknown>,
	body: AsyncIterator<unknown>,
): Promise<void> {
	try {
		await events.return?.();
		await body.return?.();
		(body as { destroy?: () => void }).destroy?.();
	} catch {
		// Already closed.
	}
}

/** A message of the chat other than a tool result. */
type ChatInput = Message & { role: ChatMessage['role'] };

/**
 * A Localmind agent as an n8n chat model, through the OpenAI-compatible endpoint.
 *
 * The agent answers with its own knowledge, skills and tools: the endpoint ignores client-side
 * tools, so the model refuses to run when n8n tools are bound instead of silently ignoring them.
 * The one exception is the tool n8n adds for an output parser: the agent is asked for JSON in
 * that shape instead.
 */
export class LocalmindChatModel extends BaseChatModel {
	constructor(
		agentId: string,
		private readonly node: INode,
		private readonly requests: LocalmindChatRequests,
		config?: ChatModelConfig,
	) {
		super('localmind', agentId, config);
	}

	async generate(messages: Message[], config?: ChatModelConfig): Promise<GenerateResult> {
		const response = await this.requests.complete(this.buildRequest(messages, config, false));
		// Checked first: the busy notice replaces the answer and a later failure.
		if (isSandboxBusy(response.notice)) throw this.sandboxBusyError();
		const choice = response.choices?.[0];
		const text = choice?.message?.content ?? '';
		this.throwOnAgentError(text);
		if (!text.trim()) throw this.noAnswerError();
		const parserCall = this.outputParserCall(text, response.id);
		return {
			id: response.id,
			finishReason: parserCall ? 'tool-calls' : finishReason(choice?.finish_reason),
			usage: tokenUsage(response.usage),
			message: {
				role: 'assistant',
				id: response.id,
				content: parserCall ? [parserCall] : [{ type: 'text', text }],
			},
			rawResponse: response,
		};
	}

	/**
	 * Without streaming and with an output parser bound, the JSON answer as a call of the parser's
	 * tool: n8n's AI Agent reads a parser's result from that call on every version, while a plain
	 * JSON text fails on n8n 2.16. Undefined when the answer is not a JSON object.
	 *
	 * The call goes to the parser as it is, so a bare answer gets the `output` wrapper that n8n's
	 * text path would add.
	 */
	private outputParserCall(text: string, id?: string): ContentToolCall | undefined {
		if (!this.tools.some((tool) => tool.name === OUTPUT_PARSER_TOOL)) return undefined;
		const parsed = parseJsonAnswer(text);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
		const keys = Object.keys(parsed);
		const wrapped = keys.length === 1 && keys[0] === 'output' ? parsed : { output: parsed };
		return {
			type: 'tool-call',
			toolCallId: `call_${id ?? 'localmind'}`,
			toolName: OUTPUT_PARSER_TOOL,
			input: JSON.stringify(wrapped),
		};
	}

	async *stream(messages: Message[], config?: ChatModelConfig): AsyncIterable<StreamChunk> {
		const body = await this.requests.stream(this.buildRequest(messages, config, true));
		let reason: FinishReason | undefined;
		let usage: TokenUsage | undefined;
		// n8n's AI Agent joins streamed pieces with line breaks before an output parser reads them,
		// which breaks JSON; with a parser the answer is handed over in one piece.
		const whole = this.tools.some((tool) => tool.name === OUTPUT_PARSER_TOOL);
		let collected = '';
		let sawText = false;
		let streamId: string | undefined;
		const events = parseSSEStream(body)[Symbol.asyncIterator]();
		try {
			for (;;) {
				const next = await this.nextEvent(events);
				// After [DONE] Localmind may keep the connection open while it cleans up the sandbox.
				if (next.done || next.value.data === '[DONE]') break;
				if (!next.value.data) continue;
				const chunk = jsonParse<ChatCompletionChunk>(next.value.data, { fallbackValue: {} });
				// The notice's sentence came as the delta before; the chat already shows it.
				if (isSandboxBusy(chunk.notice)) throw this.sandboxBusyError();
				streamId ??= chunk.id;
				usage = tokenUsage(chunk.usage) ?? usage;
				const choice = chunk.choices?.[0];
				const delta = choice?.delta?.content;
				if (delta) {
					this.throwOnAgentError(delta);
					sawText ||= delta.trim() !== '';
					if (whole) collected += delta;
					else yield { type: 'text-delta', id: chunk.id, delta };
				}
				if (choice?.finish_reason) reason = finishReason(choice.finish_reason);
			}
			if (!sawText) throw this.noAnswerError();
			// Text, not the parser's tool call: when streaming, n8n's AI Agent (v3) keeps only calls of
			// tools that are n8n nodes and would ask the model again, up to ten full agent runs.
			if (whole && collected) {
				// Without a ``` fence around the JSON, which older n8n parsers cannot read.
				const json = parseJsonAnswer(collected);
				const delta =
					json !== undefined && typeof json === 'object' ? JSON.stringify(json) : collected;
				yield { type: 'text-delta', id: streamId, delta };
			}
			// A stream that ends without a finish reason was cut off.
			yield { type: 'finish', finishReason: reason ?? 'other', usage };
		} finally {
			// Localmind keeps the connection open after [DONE] while it cleans up; a thrown error or an
			// early stop would leave it open too. Close it in every case.
			await closeStream(events, body);
		}
	}

	private buildRequest(
		messages: Message[],
		config: ChatModelConfig | undefined,
		stream: boolean,
	): ChatCompletionRequest {
		if (this.tools.some((tool) => tool.name !== OUTPUT_PARSER_TOOL)) throw this.toolsError();
		const outputParser = this.tools.find((tool) => tool.name === OUTPUT_PARSER_TOOL);
		const merged = this.mergeConfig(config);
		let chatMessages = messages
			// Tool results from earlier turns in the chat memory; Localmind drops tool messages anyway.
			.filter((message): message is ChatInput => message.role !== 'tool')
			.map((message) => this.toChatMessage(message))
			// n8n's AI node SDK drops images, which can leave a user message without content.
			.filter((message) => !(message.role === 'user' && message.content === ''));
		if (!chatMessages.some((message) => message.role === 'user')) {
			throw new NodeOperationError(this.node, 'The message to the Localmind agent is empty', {
				description:
					'Images from the chat do not reach the agent through the Chat Model. Add text, or use the Localmind node (Agent → Ask) for images.',
			});
		}
		if (outputParser) {
			// n8n tells the model to call the parser's tool, which a Localmind agent cannot do; the
			// instruction below replaces that paragraph.
			for (const message of chatMessages) {
				if (message.role === 'system' && typeof message.content === 'string') {
					message.content = message.content
						.split(/\n{2,}/)
						.filter((paragraph) => !paragraph.includes(OUTPUT_PARSER_TOOL))
						.join('\n\n');
				}
			}
			chatMessages = chatMessages.filter(
				(message) => !(message.role === 'system' && message.content === ''),
			);
			// Appended to the last user message: as a separate last message it would become a graph
			// agent's query (its nodes take the last message), and earlier in the chat the agent
			// tends to ignore it.
			const instruction = outputFormatInstruction(outputParser);
			const last = [...chatMessages].reverse().find((message) => message.role === 'user');
			if (last && typeof last.content === 'string') {
				last.content = `${last.content}\n\n${instruction}`;
			} else if (last && Array.isArray(last.content)) {
				last.content = [...last.content, { type: 'text', text: instruction }];
			}
		}
		return {
			model: this.modelId,
			messages: chatMessages,
			stream,
			...(stream && { stream_options: { include_usage: true } }),
			temperature: merged.temperature,
			max_tokens: merged.maxTokens,
		};
	}

	private toChatMessage(message: ChatInput): ChatMessage {
		const text = message.content
			.map((part) => (part.type === 'text' ? part.text : undefined))
			.filter((part): part is string => part !== undefined)
			.join('\n');
		const files = message.content.filter((part): part is ContentFile => part.type === 'file');
		if (message.role !== 'user' || files.length === 0) {
			return { role: message.role, content: text };
		}

		const parts: ChatContentPart[] = text ? [{ type: 'text', text }] : [];
		for (const file of files) {
			const mediaType = file.mediaType ?? sniffMediaType(file.data);
			if (mediaType?.startsWith('image/')) {
				if (!isAcceptedImage(mediaType)) {
					throw new NodeOperationError(
						this.node,
						`The Localmind Chat Model cannot pass "${mediaType}" images`,
						{
							description:
								'Localmind takes JPEG, PNG, GIF and WebP images. Convert the image first.',
						},
					);
				}
				parts.push({ type: 'image_url', image_url: { url: dataUrl(file.data, mediaType) } });
				continue;
			}
			const extension = DOCUMENT_EXTENSIONS[mediaType ?? ''];
			if (!mediaType || !extension) {
				throw new NodeOperationError(
					this.node,
					`The Localmind Chat Model cannot pass "${mediaType ?? 'unknown'}" files`,
					{ description: 'It passes images and PDF, Office, text and CSV documents.' },
				);
			}
			parts.push({
				type: 'file',
				file: { filename: documentName(file, extension), file_data: dataUrl(file.data, mediaType) },
			});
		}
		return { role: 'user', content: parts };
	}

	/** The next server-sent event; a connection that breaks off becomes a clear error. */
	private async nextEvent<T>(events: AsyncIterator<T>): Promise<IteratorResult<T>> {
		try {
			return await events.next();
		} catch (error) {
			throw new NodeOperationError(this.node, 'The answer stream from Localmind broke off', {
				description: `${(error as Error).message || 'The connection closed'}. No data arrived within the timeout, or the connection dropped. Localmind stops an answer after 10 minutes.`,
			});
		}
	}

	private noAnswerError(): NodeOperationError {
		return new NodeOperationError(this.node, 'The Localmind agent returned no answer', {
			description:
				"The agent's turn produced no visible text, for example only reasoning. A Graph Agent that pauses at an approval step cannot run through the Chat Model; use the Localmind node (Conversation → Send Message).",
		});
	}

	private sandboxBusyError(): NodeOperationError {
		return new NodeOperationError(this.node, SANDBOX_BUSY_MESSAGE, {
			description:
				'Localmind ended the answer because all code sandboxes were busy. Try again later, or use the Localmind node (Conversation → Send Message), which waits for a free sandbox.',
		});
	}

	private throwOnAgentError(text: string): void {
		const stepLimit = stepLimitFromAnswer(text);
		if (stepLimit !== undefined) {
			throw new NodeOperationError(this.node, stepLimitMessage(stepLimit), {
				description:
					"The answer is incomplete. Raise the agent's step limit in Localmind, or split the task into smaller steps.",
			});
		}
		const failure = agentErrorFromAnswer(text);
		if (failure === undefined) return;
		throw new NodeApiError(
			this.node,
			{ message: failure },
			{
				message: `Localmind: ${failure}`,
				description:
					'The Localmind agent failed while answering. Try again; if it keeps failing, check the agent in the Localmind app (its model, tools and credits).',
			},
		);
	}

	private toolsError(): NodeOperationError {
		return new NodeOperationError(
			this.node,
			'The Localmind Chat Model cannot use tools connected in n8n',
			{
				description:
					'A Localmind agent answers with its own knowledge, skills and tools; the Localmind API does not call tools defined in n8n. Remove the tools from the AI Agent, or add the capability to the agent in Localmind. An output parser is fine.',
			},
		);
	}
}
