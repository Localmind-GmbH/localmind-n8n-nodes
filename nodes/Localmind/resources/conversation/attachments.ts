import type { IDataObject, IExecuteFunctions, JsonObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import { isAcceptedImage, safeFileName } from '../../../shared/files';
import type { Deadline } from '../../../shared/polling';
import { getRun, runError } from '../../../shared/runs';
import { localmindApiRequest } from '../../../shared/transport';
import { multipartBody } from '../file/multipart';

const TEXT_MIME_TYPES = new Set([
	'application/json',
	'application/xml',
	'application/yaml',
	'application/x-yaml',
	'application/csv',
	'application/javascript',
	'application/x-ndjson',
	'application/sql',
]);

const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|log|html?|ini|toml|sql)$/i;

/** How a binary file can go into a conversation message: as an image, as inline text, or not at all. */
export function attachmentKind(mimeType: string, fileName = ''): 'image' | 'text' | undefined {
	const mime = mimeType.toLowerCase().split(';')[0].trim();
	if (isAcceptedImage(mime)) return 'image';
	// SVG is XML text; other image types are not accepted.
	if (mime.startsWith('image/') && !mime.endsWith('+xml')) return undefined;
	if (
		mime.startsWith('text/') ||
		TEXT_MIME_TYPES.has(mime) ||
		mime.endsWith('+json') ||
		mime.endsWith('+xml') ||
		TEXT_EXTENSIONS.test(fileName)
	) {
		return 'text';
	}
	return undefined;
}

/**
 * The text of a file: UTF-16 and UTF-8 by their byte-order mark, otherwise UTF-8 when the bytes
 * are valid UTF-8, else Latin-1 (close to Windows-1252, which many Windows tools still write).
 */
export function decodeText(buffer: Buffer): string {
	if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
	if (buffer[0] === 0xfe && buffer[1] === 0xff) {
		const body = Buffer.from(buffer.subarray(2, buffer.length - (buffer.length % 2)));
		return body.swap16().toString('utf16le');
	}
	if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
		return buffer.subarray(3).toString('utf8');
	}
	const text = buffer.toString('utf8');
	// Invalid UTF-8 turns into replacement characters, so the text no longer encodes to the same bytes.
	return Buffer.from(text, 'utf8').equals(buffer) ? text : buffer.toString('latin1');
}

/** Where a message's files go: the conversation's space, for the conversation's agent. */
export interface AttachmentTarget {
	conversationId: string;
	spaceId: string;
	agentId?: string;
}

/** How often the node checks whether Localmind has processed an uploaded file. */
const ATTACHMENT_POLL_MS = 1500;

/**
 * Localmind's refusals of a chat upload, by their stable code, as the node explains them. A Map,
 * not an object: a code such as "constructor" must find nothing.
 */
const UPLOAD_REFUSALS = new Map([
	[
		'upload_type_disabled',
		'This file type is switched off for the organization or the space in Localmind (by default, for example, .doc, .xls, .odt, .rtf and .zip). An admin can switch it on in the chat settings.',
	],
	['upload_type_unsupported', 'Localmind does not take this file type in conversations.'],
	['upload_type_runnable', 'Localmind does not take executable files.'],
	[
		'upload_type_requires_skill',
		"Localmind hands this file type to the agent's code sandbox only, and the conversation's agent has no skill. Give the agent a skill, or switch on 'Parse' for this type in the space's chat settings.",
	],
	[
		'upload_type_requires_sandbox',
		'Localmind hands this file type to the code sandbox only, and code execution is switched off.',
	],
]);

/** Extensions for files without one, by type: Localmind tells a file's type by its extension. */
const EXTENSIONS = new Map([
	['application/pdf', 'pdf'],
	['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
	['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
	['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
	['application/msword', 'doc'],
	['application/vnd.ms-excel', 'xls'],
	['application/vnd.oasis.opendocument.text', 'odt'],
	['application/rtf', 'rtf'],
	['application/zip', 'zip'],
	['text/plain', 'txt'],
	['text/markdown', 'md'],
	['text/csv', 'csv'],
	['application/csv', 'csv'],
	['text/tab-separated-values', 'tsv'],
	['application/json', 'json'],
	['text/html', 'html'],
	['text/xml', 'xml'],
	['application/xml', 'xml'],
	['application/yaml', 'yaml'],
	['application/x-yaml', 'yaml'],
	['text/x-python', 'py'],
	['application/sql', 'sql'],
]);

const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

const SPREADSHEET = /\.(csv|tsv|xlsx|xls)$/i;

/** One of the image types the model takes, by its first bytes, for an image sent as a generic type. */
function sniffImage(data: Buffer): string | undefined {
	const ascii = (start: number, end: number) => data.subarray(start, end).toString('latin1');
	if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
	if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
	if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
	if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
	return undefined;
}

/**
 * The name a file is uploaded under: safe, and with an extension. A file from an HTTP Request or
 * Code node often has no name and is called after its field ("data"); it gets the extension of
 * its type, since Localmind refuses a name without one.
 */
function uploadName(name: string, mimeType: string, fileExtension: string | undefined): string {
	const safe = safeFileName(name);
	const dot = safe.lastIndexOf('.');
	if (dot > 0 && dot < safe.length - 1) return safe;
	const extension = [fileExtension, EXTENSIONS.get(baseType(mimeType))].find(
		(candidate): candidate is string =>
			typeof candidate === 'string' && /^[a-z\d]{1,10}$/i.test(candidate) && candidate !== 'bin',
	);
	return extension ? safeFileName(`${safe.replace(/\.$/, '')}.${extension.toLowerCase()}`) : safe;
}

const baseType = (mimeType: string) => mimeType.toLowerCase().split(';')[0].trim();

/** "report.pdf", "report (2).pdf", …: the sandbox keeps the files of a message under their names. */
function uniqueName(name: string, taken: Set<string>): string {
	const dot = name.lastIndexOf('.');
	const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
	let candidate = name;
	for (let number = 2; taken.has(candidate.toLowerCase()); number++) {
		candidate = `${stem} (${number})${extension}`;
	}
	taken.add(candidate.toLowerCase());
	return candidate;
}

/** A binary field of the item, read and named before anything is uploaded. */
interface MessageFile {
	field: string;
	originalName: string;
	/** The name it goes along under (uploads and inline text). */
	fileName: string;
	mimeType: string;
	data: Buffer;
	kind: 'image' | 'text' | undefined;
}

/**
 * Reads the item's binary fields and checks what can be checked without Localmind, before the
 * first upload: an API key cannot remove an upload that a later check would make useless.
 */
async function readFiles(
	this: IExecuteFunctions,
	itemIndex: number,
	propertyNames: string[],
): Promise<MessageFile[]> {
	const taken = new Set<string>();
	const files: MessageFile[] = [];
	for (const field of propertyNames) {
		const binary = this.helpers.assertBinaryData(itemIndex, field);
		const originalName = binary.fileName ?? field;
		const data = await this.helpers.getBinaryDataBuffer(itemIndex, field);
		const sniffed = GENERIC_TYPES.has(baseType(binary.mimeType)) ? sniffImage(data) : undefined;
		const mimeType = sniffed ?? binary.mimeType;
		const kind = attachmentKind(mimeType, originalName);
		files.push({
			field,
			originalName,
			fileName:
				kind === 'image'
					? originalName
					: uniqueName(uploadName(originalName, mimeType, binary.fileExtension), taken),
			mimeType,
			data,
			kind,
		});
	}
	return files;
}

/** Whether this Localmind takes uploads from the API key, as learned once per execution. */
const uploadsOffered = new WeakMap<object, boolean>();

type UploadResult =
	| { status: 'uploaded'; reference: IDataObject }
	| { status: 'not offered' }
	| { status: 'refused'; code: string; explanation: string };

/**
 * Uploads a file for the conversation and waits until Localmind has processed it. A Localmind
 * before 1.7.0 answers 401 to an API key on this route, which exists in every version.
 */
async function uploadAttachment(
	this: IExecuteFunctions,
	file: MessageFile,
	target: AttachmentTarget,
	deadline: Deadline,
	itemIndex: number,
): Promise<UploadResult> {
	const { body, contentType } = multipartBody(
		{},
		{
			field: 'file',
			fileName: file.fileName,
			mimeType: file.mimeType,
			data: file.data,
			exactName: true,
		},
	);
	let started: { run_id?: unknown };
	try {
		started = (await localmindApiRequest.call(this, {
			method: 'POST',
			path: '/chat/attachments/parse-async',
			// persist keeps the original for the code sandbox; the agent may open it there.
			qs: {
				space_id: target.spaceId,
				persist: 'true',
				conversation_id: target.conversationId,
				...(target.agentId && { agent_id: target.agentId }),
			},
			body,
			headers: { 'content-type': contentType },
			itemIndex,
		})) as { run_id?: unknown };
	} catch (error) {
		if (!(error instanceof NodeApiError)) {
			throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
		}
		if (error.httpCode === '401') return { status: 'not offered' };
		const code = error.context.localmindCode;
		const explanation = typeof code === 'string' ? UPLOAD_REFUSALS.get(code) : undefined;
		if (typeof code === 'string' && explanation) return { status: 'refused', code, explanation };
		throw new NodeApiError(this.getNode(), error as unknown as JsonObject, { itemIndex });
	}
	if (typeof started.run_id !== 'string' || !started.run_id) {
		throw new NodeOperationError(
			this.getNode(),
			`Localmind did not start processing the attachment "${file.fileName}"`,
			{ itemIndex },
		);
	}
	for (;;) {
		const run = await getRun.call(this, started.run_id, itemIndex);
		if (run.status === 'COMPLETED') {
			const reference = run.result_data as unknown;
			if (typeof reference === 'object' && reference !== null) {
				return { status: 'uploaded', reference: reference as IDataObject };
			}
			throw new NodeOperationError(
				this.getNode(),
				`Localmind processed the attachment "${file.fileName}" but returned no reference`,
				{ itemIndex },
			);
		}
		if (run.status === 'FAILED' || run.status === 'CANCELLED') {
			const reason = (runError(run) ?? 'Processing failed').replace(/\.$/, '');
			throw new NodeOperationError(
				this.getNode(),
				`Localmind could not process the attachment "${file.fileName}"`,
				{
					itemIndex,
					description: SPREADSHEET.test(file.fileName)
						? `${reason}. A spreadsheet too large to read needs an agent with a skill, which then gets the file in its code sandbox.`
						: `${reason}.`,
				},
			);
		}
		if (deadline.expired) {
			throw new NodeOperationError(
				this.getNode(),
				`Localmind did not process the attachment "${file.fileName}" within ${deadline.duration}`,
				{ itemIndex, description: 'The message was not sent. Raise the timeout, or try again.' },
			);
		}
		await deadline.wait(ATTACHMENT_POLL_MS, this);
	}
}

const CONVERT_IMAGE =
	'Convert other images to JPEG, PNG, GIF or WebP, which go to the model on every Localmind version.';

/** Refuses a file this Localmind takes neither as an upload nor inline (before 1.7.0). */
function refuseUnsupported(this: IExecuteFunctions, files: MessageFile[], itemIndex: number) {
	const file = files.find((candidate) => !candidate.kind);
	if (!file) return;
	throw new NodeOperationError(
		this.getNode(),
		`"${file.originalName}" (${file.mimeType}) cannot be attached to a conversation message`,
		{
			itemIndex,
			description: `This Localmind takes only JPEG, PNG, GIF and WebP images and text files in conversations from an API key; PDF, Office and other files need Localmind 1.7.0. ${
				file.mimeType.toLowerCase().startsWith('image/')
					? CONVERT_IMAGE
					: 'Send PDF and Office documents with Agent → Ask.'
			}`,
		},
	);
}

/** Explains a refused upload: what Localmind said, and what helps for this file. */
function refusal(
	this: IExecuteFunctions,
	file: MessageFile,
	code: string,
	explanation: string,
	itemIndex: number,
): NodeOperationError {
	const hints = [explanation];
	if (!/\.[^.]+$/.test(file.fileName)) {
		hints.push(
			`Localmind tells a file's type by its extension, and "${file.fileName}" has none: give the file a name with its extension in the step before.`,
		);
	}
	if (file.mimeType.toLowerCase().startsWith('image/')) hints.push(CONVERT_IMAGE);
	return new NodeOperationError(
		this.getNode(),
		`Localmind refused the attachment "${file.fileName}" (${code})`,
		{ itemIndex, description: hints.join(' ') },
	);
}

const inlineText = (file: MessageFile): IDataObject => ({
	type: 'file',
	content: decodeText(file.data),
	filename: file.fileName,
	media_type: file.mimeType,
});

/**
 * The attachments of a message from the item's binary properties.
 *
 * JPEG, PNG, GIF and WebP images go along as data URIs, on every Localmind version. Every other
 * file is uploaded for the conversation (Localmind 1.7.0 and later), which hands the agent its
 * text and the original file in the code sandbox. A text file whose type the space's chat
 * settings do not take goes along inline instead, as Localmind still accepts that and as before
 * 1.7.0. A Localmind before 1.7.0 takes no uploads from an API key: text files then go along
 * inline, other files are refused.
 */
export async function buildAttachments(
	this: IExecuteFunctions,
	itemIndex: number,
	propertyNames: string[],
	target: () => Promise<AttachmentTarget>,
	deadline: Deadline,
): Promise<IDataObject[]> {
	const files = await readFiles.call(this, itemIndex, propertyNames);
	if (uploadsOffered.get(this) === false) refuseUnsupported.call(this, files, itemIndex);

	const attachments: IDataObject[] = [];
	for (const file of files) {
		if (file.kind === 'image') {
			attachments.push({
				type: 'image',
				url: `data:${file.mimeType};base64,${file.data.toString('base64')}`,
				filename: file.fileName,
				media_type: file.mimeType,
			});
			continue;
		}
		if (uploadsOffered.get(this) === false) {
			attachments.push(inlineText(file));
			continue;
		}
		const result = await uploadAttachment.call(this, file, await target(), deadline, itemIndex);
		if (result.status === 'uploaded') {
			uploadsOffered.set(this, true);
			attachments.push(result.reference);
			continue;
		}
		if (result.status === 'not offered') {
			if (uploadsOffered.get(this) === true) {
				throw new NodeOperationError(
					this.getNode(),
					`Localmind did not take the attachment "${file.fileName}"`,
					{ itemIndex },
				);
			}
			// Remembered for the execution: every item would otherwise send its files in vain.
			uploadsOffered.set(this, false);
			refuseUnsupported.call(this, files, itemIndex);
			attachments.push(inlineText(file));
			continue;
		}
		if (file.kind !== 'text') {
			throw refusal.call(this, file, result.code, result.explanation, itemIndex);
		}
		attachments.push(inlineText(file));
	}
	return attachments;
}
