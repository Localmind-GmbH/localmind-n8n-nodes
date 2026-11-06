import type { IDataObject } from 'n8n-workflow';

import { SANDBOX_BUSY_MESSAGE, stepLimitMessage } from '../../../shared/errors';
import {
	fileDetails,
	generatedFilePath,
	specificMimeType,
	type GeneratedFile,
} from '../../../shared/files';

/** A message as the conversation endpoints return it. */
export interface ConversationMessage {
	id?: string | null;
	role: string;
	content: string;
	timestamp?: string | null;
	prompt_tokens?: number | null;
	completion_tokens?: number | null;
	total_tokens?: number | null;
	parent_message_id?: string | null;
	metadata?: IDataObject | null;
	is_streaming?: boolean;
	/** From Localmind 1.7.0: the files the message offers for download, empty when there are none. */
	generated_files?: unknown[] | null;
}

/** Why a finished turn has no usable answer. */
export interface TurnFailure {
	message: string;
	description?: string;
	code?: string;
}

function widgets(message: ConversationMessage): IDataObject[] {
	const list = message.metadata?.widgets;
	return Array.isArray(list)
		? list.filter((widget): widget is IDataObject => typeof widget === 'object' && widget !== null)
		: [];
}

/** The message's "info" widget of the given type, such as "sandbox_queued". */
export function infoWidget(
	message: ConversationMessage,
	infoType: string,
): IDataObject | undefined {
	return widgets(message).find((widget) => widget.type === 'info' && widget.info_type === infoType);
}

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

const isEntry = (value: unknown): value is IDataObject =>
	typeof value === 'object' && value !== null;

/** One generated file, read the same way from either source; undefined without a link. */
function generatedFile(
	url: unknown,
	filename: unknown,
	size: unknown,
	mimeType: unknown,
): GeneratedFile | undefined {
	if (!isText(url)) return undefined;
	const fileName = isText(filename) ? filename : undefined;
	return {
		fileName: fileName ?? 'file',
		url,
		// An unusable link gets an empty path, refused later.
		path: generatedFilePath(url, fileName) ?? '',
		// Localmind writes 0 when it does not know the size: that is unknown, not an empty file.
		size: typeof size === 'number' && size > 0 ? size : undefined,
		mimeType: specificMimeType(typeof mimeType === 'string' ? mimeType : undefined),
	};
}

/**
 * The files the agent generated with code execution in this message.
 *
 * From Localmind 1.7.0 the message lists them in its documented `generated_files` field, empty
 * when there are none. Older versions keep them only in the message's "file_download" widgets,
 * the app's display data, from which Localmind itself fills that field.
 */
export function generatedFiles(message: ConversationMessage): GeneratedFile[] {
	const files = new Map<string, GeneratedFile>();
	// By path: a message can list a file once with an unencoded and once with an encoded link.
	const add = (file: GeneratedFile | undefined) => {
		if (file) files.set(file.path || file.url, file);
	};
	if (Array.isArray(message.generated_files)) {
		for (const entry of message.generated_files.filter(isEntry)) {
			add(generatedFile(entry.url, entry.filename, entry.size_bytes, entry.mime_type));
		}
		return [...files.values()];
	}
	for (const widget of widgets(message)) {
		if (widget.type !== 'file_download' || !Array.isArray(widget.files)) continue;
		for (const entry of (widget.files as unknown[]).filter(isEntry)) {
			add(generatedFile(entry.url, entry.filename, entry.size, entry.content_type));
		}
	}
	return [...files.values()];
}

/**
 * The answer to a user message: the last assistant message whose parent is that message.
 * The last, because a turn that fails after a tool call keeps its partial message and the error
 * message follows it.
 */
export function answerFor(
	messages: ConversationMessage[],
	userMessageId: string,
): ConversationMessage | undefined {
	return messages
		.filter(
			(message) => message.role === 'assistant' && message.parent_message_id === userMessageId,
		)
		.pop();
}

/** Whether the message waits at an approval step; a decided step keeps its widget with a new status. */
function awaitsApproval(message: ConversationMessage): boolean {
	return widgets(message).some(
		(widget) =>
			widget.type === 'approval' && (widget.status === undefined || widget.status === 'pending'),
	);
}

/**
 * Why the answer of a finished turn is not usable, or undefined when it is. With
 * `whileWaiting`, a turn still waiting for a code-execution slot is not counted as failed.
 */
export function turnFailure(
	answer: ConversationMessage,
	{ whileWaiting = false } = {},
): TurnFailure | undefined {
	const metadata = answer.metadata ?? {};
	if (metadata.error === true) {
		const text = metadata.error_message ?? answer.content;
		return {
			message: typeof text === 'string' && text ? text : 'The agent failed to answer',
			code: typeof metadata.code === 'string' ? metadata.code : undefined,
		};
	}
	if (metadata.cancelled === true) {
		return {
			message: 'The turn was stopped in the Localmind app',
			description: 'The answer is incomplete.',
		};
	}
	if (awaitsApproval(answer)) {
		return {
			message: 'The agent paused at an approval step',
			description:
				'Approve or reject the step in the Localmind app; approvals are not possible with an API key. The rest of the answer then arrives in the conversation.',
		};
	}
	const stepLimit = infoWidget(answer, 'recursion_limit');
	if (stepLimit) {
		return {
			message: stepLimitMessage(
				typeof stepLimit.recursion_limit === 'number' ? stepLimit.recursion_limit : undefined,
			),
			description:
				'The answer is incomplete. Send another message such as "continue" to the same conversation to let the agent go on, or raise its step limit in Localmind.',
		};
	}
	const busy = infoWidget(answer, 'sandbox_busy');
	if (busy) {
		const retry =
			typeof busy.retry_after_seconds === 'number'
				? ` Try again in about ${Math.ceil(busy.retry_after_seconds / 60)} minute(s).`
				: '';
		return {
			message: SANDBOX_BUSY_MESSAGE,
			description: `The answer is incomplete.${retry}`,
		};
	}
	const queued = infoWidget(answer, 'sandbox_queued');
	// A retired card (resolved) means the wait is over; an open one, that the turn still waits.
	if (queued && (!whileWaiting || queued.resolved === true)) {
		return {
			message: 'The turn waited for a code-execution slot and did not finish',
			description:
				'The wait ended, or the run that resumed the turn failed. The answer is incomplete; send the message again.',
		};
	}
	return undefined;
}

/** Token usage of an assistant message. */
export function tokenUsage(message: ConversationMessage): IDataObject {
	return {
		prompt: message.prompt_tokens ?? 0,
		completion: message.completion_tokens ?? 0,
		total: message.total_tokens ?? 0,
	};
}

/** The tool calls the agent made for this message, as Localmind recorded them. */
export function toolCalls(message: ConversationMessage): IDataObject[] {
	const calls = message.metadata?.tool_executions;
	return Array.isArray(calls) ? (calls as IDataObject[]) : [];
}

/**
 * Where an assistant message stands: still being written, waiting for a code-execution slot,
 * failed, or complete. Get Messages can run while a turn is still going.
 */
export function messageStatus(
	message: ConversationMessage,
	superseded = false,
	resuming = false,
): string {
	if (message.is_streaming || resuming) return 'in progress';
	// A turn that fails after a tool call keeps its partial message; the error message follows it.
	if (superseded) return 'incomplete';
	if (turnFailure(message, { whileWaiting: true })) return 'failed';
	if (infoWidget(message, 'sandbox_queued')) return 'waiting for a code sandbox';
	return 'complete';
}

/** A message reduced to what a workflow usually needs. */
export function simplifyMessage(
	message: ConversationMessage,
	superseded = false,
	resuming = false,
): IDataObject {
	const simplified: IDataObject = {
		id: message.id,
		role: message.role,
		text: message.content,
		timestamp: message.timestamp,
		parentMessageId: message.parent_message_id,
	};
	if (message.role === 'assistant') {
		simplified.status = messageStatus(message, superseded, resuming);
		simplified.files = generatedFiles(message).map(fileDetails);
		simplified.tokens = tokenUsage(message);
		const failure = !resuming && turnFailure(message, { whileWaiting: true });
		// Not "error": n8n 2.16 counts any item with an "error" key as failed (Retry On Fail).
		if (failure) simplified.errorMessage = failure.message;
	}
	return simplified;
}

/** IDs of assistant messages followed by a later assistant message answering the same user message. */
export function supersededMessages(messages: ConversationMessage[]): Set<string> {
	const superseded = new Set<string>();
	const lastByParent = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== 'assistant' || !message.id || !message.parent_message_id) continue;
		const earlier = lastByParent.get(message.parent_message_id);
		if (earlier) superseded.add(earlier);
		lastByParent.set(message.parent_message_id, message.id);
	}
	return superseded;
}
