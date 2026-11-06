import type { IDataObject, IExecuteFunctions, INodeExecutionData, JsonObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import {
	attachGeneratedFiles,
	downloadSettings,
	type DownloadOptions,
} from '../../../shared/files';
import { commaList, idParam, textParam, UUID } from '../../../shared/params';
import { Deadline, timeoutMs } from '../../../shared/polling';
import { localmindApiRequest, localmindApiRequestAllItems } from '../../../shared/transport';
import { getLimit } from '../common';
import { buildAttachments, type AttachmentTarget } from './attachments';
import {
	generatedFiles,
	simplifyMessage,
	supersededMessages,
	tokenUsage,
	toolCalls,
	turnFailure,
	type ConversationMessage,
} from './messages';
import {
	MAX_MESSAGE_LENGTH,
	resumingMessages,
	waitForAnswer,
	type QueuedTurn,
} from './sendMessage';
import { simplifyConversation } from '../simplify';

interface ConversationFilters {
	agentId?: string;
	includeSharedWithMe?: boolean;
	search?: string;
	spaceId?: string;
	title?: string;
}

interface SendMessageOptions extends DownloadOptions {
	attachments?: unknown;
	disabledToolIds?: unknown;
	includeToolCalls?: boolean;
	timeoutMinutes?: unknown;
}

const TOOL_ID = new RegExp(UUID);

function conversationOutput(
	this: IExecuteFunctions,
	conversation: IDataObject,
	itemIndex: number,
): IDataObject {
	const simplify = this.getNodeParameter('simplify', itemIndex, true) as boolean;
	return simplify ? simplifyConversation(conversation) : conversation;
}

function conversationPath(this: IExecuteFunctions, itemIndex: number): string {
	const id = this.getNodeParameter('conversation', itemIndex, '', { extractValue: true }) as string;
	return `/conversations/${encodeURIComponent(id)}`;
}

function parseToolIds(this: IExecuteFunctions, value: unknown, itemIndex: number): string[] {
	const ids = textParam(value)
		.split(/[\s,]+/)
		.map((id) => id.trim())
		.filter(Boolean);
	const invalid = ids.find((id) => !TOOL_ID.test(id));
	if (invalid) {
		throw new NodeOperationError(this.getNode(), `"${invalid}" is not a tool ID`, {
			itemIndex,
			description: "Agent → Get lists the agent's tool IDs under 'toolIds'.",
		});
	}
	return ids;
}

/**
 * Queues the message. From Localmind 1.7.0 the space's chat settings also decide whether images
 * reach the model; a refusal names only its code, so it is explained here.
 */
async function queueMessage(
	this: IExecuteFunctions,
	body: IDataObject,
	itemIndex: number,
): Promise<QueuedTurn> {
	try {
		return (await localmindApiRequest.call(this, {
			method: 'POST',
			path: `${conversationPath.call(this, itemIndex)}/messages-async`,
			body,
			itemIndex,
		})) as QueuedTurn;
	} catch (error) {
		if (!(error instanceof NodeApiError)) {
			throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
		}
		const code = error.context.localmindCode;
		if (typeof code === 'string' && code.startsWith('upload_type_')) {
			throw new NodeOperationError(
				this.getNode(),
				`Localmind refused the images of the message (${code})`,
				{
					itemIndex,
					description:
						"The space's chat settings do not let images go to the model: their type is switched off, or only stored for the code sandbox. Switch it on in the space's chat settings, or send the message without images. Files uploaded for the message stay unused in Localmind.",
				},
			);
		}
		throw new NodeApiError(this.getNode(), error as unknown as JsonObject, { itemIndex });
	}
}

async function sendMessage(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const message = textParam(this.getNodeParameter('message', itemIndex));
	// Localmind counts characters (code points); an emoji is one, not two as in message.length.
	// A message of more than twice the limit in UTF-16 units is too long whatever it contains, and
	// counting it would first build an array of every character.
	const length = message.length > MAX_MESSAGE_LENGTH * 2 ? message.length : [...message].length;
	if (length > MAX_MESSAGE_LENGTH) {
		throw new NodeOperationError(
			this.getNode(),
			`The message has ${length.toLocaleString('en')} characters; Localmind accepts at most 50,000`,
			{ itemIndex },
		);
	}
	const options = this.getNodeParameter('options', itemIndex, {}) as SendMessageOptions;
	const timeout = timeoutMs(this.getNode(), options.timeoutMinutes, itemIndex);

	const body: IDataObject = { message };
	const names = commaList(options.attachments);
	if (names.length) {
		// Read only when a file is uploaded: the conversation's space and agent take it.
		let target: Promise<AttachmentTarget> | undefined;
		const loadTarget = async () => {
			target ??= (async () => {
				const conversation = (await localmindApiRequest.call(this, {
					method: 'GET',
					path: conversationPath.call(this, itemIndex),
					itemIndex,
				})) as IDataObject;
				const agentId = conversation.active_agent_id ?? conversation.agent_id;
				return {
					conversationId: String(conversation.id),
					spaceId: String(conversation.space_id),
					...(typeof agentId === 'string' && agentId && { agentId }),
				};
			})();
			return await target;
		};
		// Its own wait: a message sent when the files took nearly all of one would time out at once.
		const processing = new Deadline(timeout);
		body.attachments = await buildAttachments.call(this, itemIndex, names, loadTarget, processing);
	}
	if (options.disabledToolIds !== undefined) {
		body.disabled_tool_ids = parseToolIds.call(this, options.disabledToolIds, itemIndex);
	}

	const turn = await queueMessage.call(this, body, itemIndex);
	const ids = {
		conversationId: turn.conversation_id,
		userMessageId: turn.user_message_id,
		runId: turn.run_id,
	};

	if (!(this.getNodeParameter('waitForAnswer', itemIndex, true) as boolean)) {
		return [{ json: { ...ids, status: 'queued' } }];
	}

	// Once the turn is queued, every error names it, so a later step can pick up the answer.
	try {
		const answer = await waitForAnswer.call(this, turn, new Deadline(timeout), itemIndex);
		const failure = turnFailure(answer);
		if (failure) {
			const detail = failure.code ? `${failure.message} (${failure.code})` : failure.message;
			throw new NodeApiError(
				this.getNode(),
				{ message: failure.message },
				{ message: `Localmind: ${detail}`, description: failure.description, itemIndex },
			);
		}

		const item: INodeExecutionData = {
			json: { ...ids, messageId: answer.id, text: answer.content, tokens: tokenUsage(answer) },
		};
		if (options.includeToolCalls) item.json.toolCalls = toolCalls(answer);
		await attachGeneratedFiles.call(
			this,
			item,
			generatedFiles(answer),
			downloadSettings.call(this, options),
			itemIndex,
		);
		return [item];
	} catch (error) {
		const where = `Conversation ${turn.conversation_id}, message ${turn.user_message_id}, run ${turn.run_id}.`;
		const failure = error as { description?: string | null };
		if (!failure.description?.includes(turn.user_message_id)) {
			failure.description = failure.description ? `${failure.description} ${where}` : where;
		}
		// Returns the same error; n8n's community-node rules forbid re-throwing it as it is.
		if (error instanceof NodeApiError) {
			throw new NodeApiError(this.getNode(), error as unknown as JsonObject, { itemIndex });
		}
		throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
	}
}

export async function executeConversation(
	this: IExecuteFunctions,
	operation: string,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	switch (operation) {
		case 'create': {
			const title = textParam(this.getNodeParameter('title', itemIndex, '')).trim();
			const conversation = await localmindApiRequest.call(this, {
				method: 'POST',
				path: '/conversations/',
				body: {
					agent_id: this.getNodeParameter('agent', itemIndex, '', { extractValue: true }),
					space_id: this.getNodeParameter('space', itemIndex, '', { extractValue: true }),
					...(title && { title }),
				},
				itemIndex,
			});
			return [{ json: conversationOutput.call(this, conversation as IDataObject, itemIndex) }];
		}

		case 'get': {
			const conversation = await localmindApiRequest.call(this, {
				method: 'GET',
				path: conversationPath.call(this, itemIndex),
				itemIndex,
			});
			return [{ json: conversationOutput.call(this, conversation as IDataObject, itemIndex) }];
		}

		case 'getAll': {
			const filters = this.getNodeParameter('filters', itemIndex, {}) as ConversationFilters;
			const conversations = await localmindApiRequestAllItems.call(
				this,
				{
					method: 'POST',
					path: '/conversations/search',
					qs: {
						...(filters.search && { search: textParam(filters.search) }),
						...(filters.includeSharedWithMe && { include_shared_with_me: true }),
					},
					body: {
						filters: {
							...(filters.agentId && { agent_id: idParam(filters.agentId) }),
							...(filters.spaceId && { space_id: idParam(filters.spaceId) }),
							...(filters.title && { title__contains: textParam(filters.title) }),
						},
						order_by: ['-last_message_at', 'id'],
					},
					idempotent: true,
					itemIndex,
				},
				getLimit.call(this, itemIndex),
			);
			return (conversations as IDataObject[]).map((conversation) => ({
				json: conversationOutput.call(this, conversation, itemIndex),
			}));
		}

		case 'delete': {
			await localmindApiRequest.call(this, {
				method: 'DELETE',
				path: conversationPath.call(this, itemIndex),
				itemIndex,
			});
			const conversationId = this.getNodeParameter('conversation', itemIndex, '', {
				extractValue: true,
			}) as string;
			return [{ json: { deleted: true, conversationId } }];
		}

		case 'getMessages': {
			const { messages = [] } = (await localmindApiRequest.call(this, {
				method: 'GET',
				path: `${conversationPath.call(this, itemIndex)}/messages`,
				itemIndex,
			})) as { messages?: ConversationMessage[] };
			const simplify = this.getNodeParameter('simplify', itemIndex, true) as boolean;
			if (!simplify)
				return messages.map((message) => ({ json: message as unknown as IDataObject }));
			const superseded = supersededMessages(messages);
			const conversationId = this.getNodeParameter('conversation', itemIndex, '', {
				extractValue: true,
			}) as string;
			const resuming = await resumingMessages.call(this, conversationId, messages, itemIndex);
			return messages.map((message) => ({
				json: simplifyMessage(
					message,
					superseded.has(message.id ?? ''),
					resuming.has(message.id ?? ''),
				),
			}));
		}

		case 'sendMessage':
			return await sendMessage.call(this, itemIndex);
	}

	throw new NodeOperationError(this.getNode(), `Unknown conversation operation "${operation}"`, {
		itemIndex,
	});
}
