import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import {
	generatedFilePath,
	isAcceptedImage,
	specificMimeType,
	type DownloadOptions,
	type GeneratedFile,
} from '../../../shared/files';
import { parseJsonAnswer } from '../../../shared/json';
import { textParam } from '../../../shared/params';

type ContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } }
	| { type: 'file'; file: { filename: string; file_data: string } };

export interface AskOptions extends DownloadOptions {
	attachments?: unknown;
	jsonOutput?: boolean;
	maxTokens?: number;
	systemMessage?: string;
	temperature?: number;
	timeoutMinutes?: unknown;
}

// OpenAI and Azure models refuse JSON mode unless a message mentions JSON.
const JSON_INSTRUCTION = 'Respond with a JSON object.';

/** The answer of `POST /v1/chat/completions`, with Localmind's `attachments` extension. */
export interface AskResponse {
	choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
	attachments?: Array<{
		filename?: string;
		url?: string;
		mime_type?: string;
		size_bytes?: number;
	}> | null;
	/** From Localmind 1.6.0: why the request ended without the agent's answer. */
	notice?: { code?: string; message?: string } | null;
}

/**
 * The content parts for the item's binary properties: images go to the agent's vision model,
 * every other file as a document block that Localmind parses to text (PDF, Office, text, CSV).
 * Localmind refuses unsupported types and too many documents with a clear 400.
 */
export async function askAttachments(
	this: IExecuteFunctions,
	itemIndex: number,
	propertyNames: string[],
): Promise<ContentPart[]> {
	const parts: ContentPart[] = [];
	for (const name of propertyNames) {
		const binary = this.helpers.assertBinaryData(itemIndex, name);
		const image = binary.mimeType.toLowerCase().startsWith('image/');
		if (image && !isAcceptedImage(binary.mimeType)) {
			throw new NodeOperationError(
				this.getNode(),
				`"${binary.fileName ?? name}" (${binary.mimeType}) cannot be sent to the agent`,
				{
					itemIndex,
					description: 'Localmind takes JPEG, PNG, GIF and WebP images. Convert the image first.',
				},
			);
		}
		const buffer = await this.helpers.getBinaryDataBuffer(itemIndex, name);
		const dataUrl = `data:${binary.mimeType};base64,${buffer.toString('base64')}`;
		parts.push(
			image
				? { type: 'image_url', image_url: { url: dataUrl } }
				: { type: 'file', file: { filename: binary.fileName ?? name, file_data: dataUrl } },
		);
	}
	return parts;
}

/** The request body for one prompt to one agent. */
export function askRequest(
	agentId: string,
	prompt: string,
	options: AskOptions,
	attachments: ContentPart[],
): IDataObject {
	const messages: IDataObject[] = [];
	const systemMessage = textParam(options.systemMessage);
	let system = systemMessage.trim() ? systemMessage : '';
	if (options.jsonOutput && !/json/i.test(`${system} ${prompt}`)) {
		system = system ? `${system}\n\n${JSON_INSTRUCTION}` : JSON_INSTRUCTION;
	}
	if (system) messages.push({ role: 'system', content: system });
	messages.push({
		role: 'user',
		content: attachments.length ? [{ type: 'text', text: prompt }, ...attachments] : prompt,
	});
	return {
		model: agentId,
		messages,
		stream: false,
		...(options.temperature !== undefined && { temperature: options.temperature }),
		...(options.maxTokens !== undefined && { max_tokens: options.maxTokens }),
		...(options.jsonOutput && { response_format: { type: 'json_object' } }),
	};
}

/** The files the agent generated, from the documented `attachments` field. */
export function askFiles(response: AskResponse): GeneratedFile[] {
	return (response.attachments ?? [])
		.filter(
			(file): file is { url: string } & typeof file =>
				typeof file === 'object' && file !== null && typeof file.url === 'string' && !!file.url,
		)
		.map((file) => ({
			fileName: file.filename || 'file',
			url: file.url,
			// An unusable link gets an empty path, refused later.
			path: generatedFilePath(file.url, file.filename) ?? '',
			size: file.size_bytes,
			mimeType: specificMimeType(file.mime_type),
		}));
}

export { parseJsonAnswer };
