import type {
	IBinaryKeyData,
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { isCancelled } from './polling';
import { localmindApiDownload } from './transport';

/** A file the agent generated, ready to download. */
export interface GeneratedFile {
	fileName: string;
	/** The download link as Localmind returned it. */
	url: string;
	/** API path of the download, below /v1. */
	path: string;
	size?: number;
	mimeType?: string;
}

const GENERIC_MIME_TYPE = 'application/octet-stream';
/**
 * A download link: a path, or an absolute URL, whose path leads to the download endpoint, also
 * behind a path prefix such as a proxy's. Only the path counts: the endpoint inside another link's
 * query or fragment, or after "//" (another host), is no download link. Case-sensitive, as
 * Localmind's paths are. The file is fetched from the credential's API URL in any case.
 */
const DOWNLOAD_PREFIX =
	/^\s*(?:[A-Za-z][A-Za-z\d+.-]*:\/\/[^/?#\s]*|(?!\/\/))(?:\/[^/?#\s]+)*?(?=\/(?:v1\/)?storage\/download\/)/;
// The only query Localmind adds to its download links; the backend derives it from the path anyway.
const ORG_QUERY = /\?org_id=[^/?#]*$/i;
const ENCODED = /%[0-9a-f]{2}/i;
const URL_SAFE = /^[\w\-.~%/!$&'()*+,;=:@]*$/;

/**
 * "/v1/storage/download/org-x/a b.xlsx" → "/storage/download/org-x/a%20b.xlsx".
 * For links Localmind builds from a stored name without encoding it, so every segment is encoded
 * as it is. Generated-file links are encoded from Localmind 1.7.0; see `generatedFilePath`.
 */
export function downloadPath(url: string): string {
	return url
		.replace(/^\/v1(?=\/)/, '')
		.split('/')
		.map((segment) => encodeURIComponent(segment))
		.join('/');
}

/** Why a download link is not followed. */
export const UNSAFE_LINK_REFUSAL =
	'The link has "." or ".." path segments, empty segments or encoded slashes, which could lead out of the download endpoint';

/**
 * Whether an API path stays inside Localmind's download endpoint. Checked on the final path, after
 * encoding: every segment, decoded, must be a plain name, not empty ("//"), not "." or "..", and
 * without a "/" or "\" of its own (%2F, %5C). Otherwise the path could reach any other GET
 * endpoint with the user's key, and a link can come from an agent's answer or an email.
 */
export function isSafeDownloadPath(apiPath: string): boolean {
	if (!apiPath.startsWith('/storage/download/')) return false;
	return apiPath
		.slice(1)
		.split('/')
		.every((segment) => {
			// Decoded until stable, since a proxy in between might decode once more.
			let decoded = segment;
			for (let round = 0; round < 3; round++) {
				if (decoded === '' || decoded === '.' || decoded === '..' || /[\\/]/.test(decoded)) {
					return false;
				}
				let next: string;
				try {
					next = decodeURIComponent(decoded);
				} catch {
					// After a first decoding, a "%" that is no escape is part of the name ("50% off.pdf").
					return round > 0;
				}
				if (next === decoded) return true;
				decoded = next;
			}
			return false;
		});
}

/** Whether a link points to Localmind's download endpoint at all, safe or not. */
export function isDownloadLink(url: string): boolean {
	return DOWNLOAD_PREFIX.test(url);
}

/**
 * The API path of a Localmind download link, absolute or relative; undefined for other links and
 * for links that would leave the download endpoint (see `isSafeDownloadPath`).
 *
 * "raw" encodes the path: for links the API builds from the stored name, where a file name may
 * contain spaces, "#" or "?" (File → Download). "encoded" keeps a link that is encoded already.
 * "auto" guesses: it keeps a link with escapes and nothing left to encode, and encodes any other;
 * for links pasted from a browser, where nothing tells the two forms apart.
 */
export function downloadLinkPath(
	url: string,
	source: 'raw' | 'encoded' | 'auto',
): string | undefined {
	const match = DOWNLOAD_PREFIX.exec(url);
	if (!match) return undefined;
	let path = url.slice(match[0].length).trim().replace(ORG_QUERY, '');
	if (!path.startsWith('/v1/')) path = `/v1${path}`;
	const keep =
		URL_SAFE.test(path) && (source === 'encoded' || (source === 'auto' && ENCODED.test(path)));
	const apiPath = keep ? path.replace(/^\/v1(?=\/)/, '') : downloadPath(path);
	return isSafeDownloadPath(apiPath) ? apiPath : undefined;
}

function decodedOrUndefined(segment: string): string | undefined {
	try {
		return decodeURIComponent(segment);
	} catch {
		return undefined;
	}
}

/**
 * The API path of a generated file's download link, like `downloadLinkPath`.
 *
 * Localmind builds the link from the file's stored name: unencoded up to 1.6.0, encoded from
 * 1.7.0, and a message keeps the link it was saved with. The link ends in the file's name in one
 * of the two forms, which tells them apart; a name with "%20" in it is not taken for an encoded
 * space. When the name matches neither form, the link's form is guessed ("auto").
 */
export function generatedFilePath(url: string, fileName?: string): string | undefined {
	const last = url.replace(ORG_QUERY, '').split('/').pop() ?? '';
	if (!fileName) return downloadLinkPath(url, 'auto');
	if (last === fileName) return downloadLinkPath(url, 'raw');
	if (decodedOrUndefined(last) === fileName) return downloadLinkPath(url, 'encoded');
	return downloadLinkPath(url, 'auto');
}

/** A MIME type worth passing on: undefined for the generic one, so n8n detects it from the name. */
export function specificMimeType(mimeType?: string): string | undefined {
	return mimeType && !mimeType.startsWith(GENERIC_MIME_TYPE) ? mimeType : undefined;
}

/** A MIME type safe for a header line; anything else (for example with line breaks) becomes generic. */
export function safeMimeType(mimeType: string): string {
	return /^[\w.+-]+\/[\w.+-]+(?:\s*;\s*[\w.+-]+=[\w.+"-]+)*$/.test(mimeType)
		? mimeType
		: GENERIC_MIME_TYPE;
}

/** The first of the MIME types Localmind sent that is specific and well-formed. */
export function binaryMimeType(...mimeTypes: Array<string | undefined>): string | undefined {
	return mimeTypes
		.map((mimeType) => specificMimeType(mimeType && safeMimeType(mimeType)))
		.find(Boolean);
}

/**
 * File systems and Localmind's code sandbox take names of up to 255 bytes; 200 leave room for a
 * number such as " (2)". Counted in UTF-8 bytes: a Chinese character takes three.
 */
const MAX_FILE_NAME_BYTES = 200;

/**
 * Control and invisible format characters: the direction marks that can disguise an extension
 * (U+202E makes "report<U+202E>fdp.exe" show as "reportexe.pdf"), zero-width spaces, soft
 * hyphens, byte-order marks. Kept are the joiners that Persian and other scripts and emoji
 * sequences need (U+200C, U+200D) and the tag characters of flag emoji.
 */
const HIDDEN_CHARACTER = /(?!\u200C|\u200D|[\u{E0020}-\u{E007F}])[\p{Cc}\p{Cf}]/u;

/**
 * A file name from Localmind, safe for the steps after the node (saving the file, attaching it to a
 * mail): its last path segment only, without hidden characters, at most 200 bytes.
 */
export function safeFileName(name: string | undefined): string {
	const last = (name ?? '').split(/[/\\]/).pop() ?? '';
	const visible = Array.from(last)
		.filter((char) => !HIDDEN_CHARACTER.test(char))
		.join('')
		.trim();
	const usable = visible === '.' || visible === '..' ? '' : visible;
	if (Buffer.byteLength(usable) <= MAX_FILE_NAME_BYTES) return usable || 'file';
	const dot = usable.lastIndexOf('.');
	const extension = dot > 0 && usable.length - dot <= 16 ? usable.slice(dot) : '';
	let room = MAX_FILE_NAME_BYTES - Buffer.byteLength(extension);
	let kept = '';
	// Whole characters only, so that shortening never splits one such as an emoji.
	for (const char of usable.slice(0, usable.length - extension.length)) {
		room -= Buffer.byteLength(char);
		if (room < 0) break;
		kept += char;
	}
	return kept + extension;
}

/**
 * A generated file as the nodes list it: a safe name and type, for steps that build a path or a
 * mail from it. The link stays as Localmind sent it, for File → Download by URL.
 */
function fileDetails(
	{ fileName, size, mimeType, url }: GeneratedFile,
	isLabel: boolean,
): IDataObject {
	return {
		fileName: safeFileName(fileName),
		size,
		mimeType: binaryMimeType(mimeType),
		url,
		...(isLabel && { provenance: true }),
	};
}

/** The generated files as the nodes list them, AI labels marked `provenance: true`. */
export function listFiles(files: GeneratedFile[]): IDataObject[] {
	const labels = labelIndexes(files);
	return files.map((file, index) => fileDetails(file, labels.has(index)));
}

const LABEL_SUFFIX = '.provenance.json';

/** An AI label is a small JSON file; one larger than this is not downloaded. */
const MAX_LABEL_BYTES = 1024 * 1024;

/**
 * Which files are AI labels: from Localmind 1.7.0, a generated CSV or JSON file, whose format has
 * no room for an AI label (EU AI Act), comes with "<file name>.provenance.json". A label counts
 * only next to its file in the list, since the agent, or a prompt injected into it, chooses the
 * names. Labels are not counted towards 'Max Files to Download' but have their own count of the
 * same size, and at most 1 MB each.
 */
function labelIndexes(files: GeneratedFile[]): Set<number> {
	const names = new Set(files.map((file) => file.fileName));
	const labels = new Set<number>();
	for (const [index, { fileName }] of files.entries()) {
		const isLabel =
			fileName.toLowerCase().endsWith(LABEL_SUFFIX) &&
			names.has(fileName.slice(0, -LABEL_SUFFIX.length));
		if (isLabel) labels.add(index);
	}
	return labels;
}

/** The prefix of the binary fields for generated files: file_0, file_1, … */
export const DEFAULT_BINARY_PREFIX = 'file_';

/** The prefix option's value; an empty or blank one falls back to the default. */
export function binaryPrefix(value: unknown): string {
	const prefix = typeof value === 'string' ? value.trim() : '';
	return prefix || DEFAULT_BINARY_PREFIX;
}

/** The download options of Ask and Send Message. */
export interface DownloadOptions {
	downloadFiles?: boolean;
	binaryPropertyPrefix?: string;
	maxFiles?: number;
	maxFileSizeMb?: number;
}

/** How generated files are downloaded, from the options and the way the node runs. */
export interface DownloadSettings {
	download: boolean;
	prefix: string;
	maxFiles: number;
	maxBytes: number;
}

export const DEFAULT_MAX_FILES = 10;
export const DEFAULT_MAX_FILE_SIZE_MB = 50;

/**
 * The download settings. As a tool of n8n's AI Agent, nobody receives the files and an injected
 * prompt could make the agent write many large ones, so downloading is off unless switched on.
 */
export function downloadSettings(
	this: IExecuteFunctions,
	options: DownloadOptions,
): DownloadSettings {
	const toolMode = this.getNode().type.endsWith('Tool');
	return {
		download: options.downloadFiles ?? !toolMode,
		prefix: binaryPrefix(options.binaryPropertyPrefix),
		maxFiles: Math.floor(positive(options.maxFiles, DEFAULT_MAX_FILES)),
		maxBytes: maxFileBytes(options.maxFileSizeMb),
	};
}

const positive = (value: unknown, fallback: number) =>
	typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

/** A size in MB for messages: "50 MB", "1.5 MB". */
export const megabytes = (bytes: number) =>
	`${Number((bytes / 1024 / 1024).toFixed(1)).toLocaleString('en')} MB`;

/** A "Max File Size (MB)" option in bytes; 50 MB when it is not a positive number. */
export const maxFileBytes = (megabytes: unknown) =>
	Math.floor(positive(megabytes, DEFAULT_MAX_FILE_SIZE_MB) * 1024 * 1024);

/**
 * Lists the generated files on the item and, if wanted, downloads them as binary fields
 * (prefix + index). A file that is refused, over a limit or fails to download keeps its link and
 * gets `errorMessage` (not `error`, which n8n would count as a failed item); the answer is kept.
 */
export async function attachGeneratedFiles(
	this: IExecuteFunctions,
	item: INodeExecutionData,
	files: GeneratedFile[],
	settings: DownloadSettings,
	itemIndex: number,
): Promise<void> {
	const labels = labelIndexes(files);
	const details = files.map((file, index) => fileDetails(file, labels.has(index)));
	item.json.files = details;
	if (!settings.download || files.length === 0) return;

	const binary: IBinaryKeyData = {};
	// AI labels have a count of their own, so they cannot push a file out, nor a server send endless ones.
	const counts = { files: 0, labels: 0 };
	for (const [index, file] of files.entries()) {
		const kind = labels.has(index) ? 'labels' : 'files';
		const beyondLimit = counts[kind]++ >= settings.maxFiles;
		const maxBytes =
			kind === 'labels' ? Math.min(settings.maxBytes, MAX_LABEL_BYTES) : settings.maxBytes;
		const tooLarge =
			kind === 'labels' && maxBytes < settings.maxBytes
				? 'Not downloaded: larger than 1 MB, the limit for AI-label files'
				: `Not downloaded: larger than ${megabytes(maxBytes)} ('Max File Size (MB)')`;
		if (!isSafeDownloadPath(file.path)) {
			details[index].errorMessage = UNSAFE_LINK_REFUSAL;
			continue;
		}
		if (beyondLimit) {
			details[index].errorMessage =
				`Not downloaded: more than ${settings.maxFiles} ${kind === 'labels' ? 'AI-label files' : 'files'} ('Max Files to Download')`;
			continue;
		}
		if (typeof file.size === 'number' && file.size > maxBytes) {
			details[index].errorMessage = tooLarge;
			continue;
		}
		try {
			const { data, contentType } = await localmindApiDownload.call(
				this,
				{ method: 'GET', path: file.path, itemIndex },
				maxBytes,
			);
			if (data.length > maxBytes) {
				details[index].errorMessage = tooLarge;
				continue;
			}
			const property = `${settings.prefix}${index}`;
			binary[property] = await this.helpers.prepareBinaryData(
				data,
				safeFileName(file.fileName),
				binaryMimeType(file.mimeType, contentType),
			);
			details[index].binaryProperty = property;
		} catch (error) {
			// Stop means stop, not "carry on with the next file".
			if (isCancelled(this)) {
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			}
			details[index].errorMessage = (error as Error).message;
		}
	}
	if (Object.keys(binary).length) item.binary = binary;
}

/** The image types Localmind accepts from an API key (others get a 400 from 1.5.0 on). */
const ACCEPTED_IMAGE_TYPES = new Set([
	'image/jpeg',
	'image/jpg',
	'image/png',
	'image/gif',
	'image/webp',
]);

/** Whether Localmind accepts this image type in a message; a MIME parameter is ignored. */
export function isAcceptedImage(mimeType: string): boolean {
	return ACCEPTED_IMAGE_TYPES.has(mimeType.toLowerCase().split(';')[0].trim());
}
