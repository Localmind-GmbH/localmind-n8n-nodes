import type { IDataObject, INodeProperties } from 'n8n-workflow';

import { pipelineStatus, storedPath, type LocalmindDocument } from '../../shared/documents';
import { isRunFinished, runError, type PipelineRun } from '../../shared/runs';

/** n8n's "Simplify" option for an operation whose raw answer has more than ten fields. */
export function simplifyProperty(resource: string, operation: string[]): INodeProperties {
	return {
		displayName: 'Simplify',
		name: 'simplify',
		type: 'boolean',
		default: true,
		displayOptions: { show: { resource: [resource], operation } },
		description: 'Whether to return a simplified version of the response instead of the raw data',
	};
}

type Raw = IDataObject;

/** An agent's configuration reduced to what a workflow usually needs. */
export function simplifyAgent(agent: Raw): IDataObject {
	const tools = Array.isArray(agent.tool_attachments) ? (agent.tool_attachments as Raw[]) : [];
	return {
		id: agent.id,
		name: agent.name,
		description: agent.description,
		model: agent.model,
		agentType: agent.agent_type,
		spaceId: agent.space_id,
		temperature: agent.temperature,
		maxTokens: agent.max_tokens,
		toolIds: tools
			.filter((tool) => typeof tool === 'object' && tool !== null)
			.map((tool) => tool.tool_id),
		updatedAt: agent.updated_at,
	};
}

/** A conversation reduced to what a workflow usually needs. */
export function simplifyConversation(conversation: Raw): IDataObject {
	return {
		id: conversation.id,
		title: conversation.title,
		agentId: conversation.agent_id,
		spaceId: conversation.space_id,
		createdAt: conversation.created_at,
		updatedAt: conversation.updated_at,
		lastMessageAt: conversation.last_message_at,
		disabledToolIds: conversation.disabled_tool_ids ?? [],
		sharedWithMe: conversation.is_shared_with_me ?? false,
		tags: conversation.tags ?? [],
	};
}

/** A document reduced to what a workflow usually needs. */
export function simplifyDocument(document: LocalmindDocument & Raw): IDataObject {
	const path = storedPath(document);
	const status = pipelineStatus(document);
	return {
		id: document.id,
		name: path?.split('/').pop() ?? document.file_path?.split('/').pop(),
		path,
		fileType: document.file_type,
		fileSize: document.file_size,
		// Localmind's "stored_only" as "stored", the word File → Upload uses for the same files.
		status: status === 'stored_only' ? 'stored' : (status ?? 'processing'),
		metadata: document.doc_metadata ?? {},
		spaceId: document.space_id,
		createdAt: document.created_at,
		updatedAt: document.updated_at,
	};
}

/** A processing run reduced to what a workflow usually needs. */
export function simplifyRun(run: PipelineRun & Raw): IDataObject {
	const failure = runError(run);
	return {
		runId: run.id,
		status: run.status,
		finished: isRunFinished(run),
		type: run.pipeline_type,
		documentId: run.document_id,
		spaceId: run.space_id,
		createdAt: run.created_at,
		startedAt: run.started_at,
		completedAt: run.completed_at,
		// Not "error": n8n 2.16 counts any item with an "error" key as failed (Retry On Fail).
		...(failure && { errorMessage: failure }),
	};
}
