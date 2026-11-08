import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import {
	findDocumentByPath,
	pipelineStatus,
	waitForDocument,
	type LocalmindDocument,
} from '../../../shared/documents';
import {
	binaryMimeType,
	downloadLinkPath,
	isDownloadLink,
	maxFileBytes,
	megabytes,
	safeFileName,
	UNSAFE_LINK_REFUSAL,
} from '../../../shared/files';
import {
	localmindApiDownload,
	localmindApiRequest,
	UPLOAD_TIMEOUT_MS,
} from '../../../shared/transport';
import { normalizeFolder, textParam } from '../../../shared/params';
import { Deadline, isCancelled, timeoutMs } from '../../../shared/polling';
import { entriesIn, isLinked, listEntries } from './folders';
import { multipartBody } from './multipart';

interface UploadOptions {
	fileName?: unknown;
	timeoutMinutes?: unknown;
	waitForProcessing?: boolean;
}

interface UploadResponse {
	relative_path: string;
	size?: number;
	content_type?: string;
	renamed?: boolean;
	job_id?: string | null;
	extracted_files?: string[] | null;
}

const DEFAULT_UPLOAD_TIMEOUT_MINUTES = 10;
// Localmind stores these without indexing them; up to 1.5.0 it tries anyway and marks them failed.
const STORED_ONLY = /\.(mp3|wav|m4a|ogg|html?)$/i;

/**
 * A file-manager path, from the space root. A "." or ".." segment could lead out of the space or
 * to another file than meant, so it is refused before anything is sent.
 */
function plainPath(this: IExecuteFunctions, path: string, itemIndex: number): string {
	if (path.split(/[/\\]/).some((segment) => segment === '.' || segment === '..')) {
		throw new NodeOperationError(this.getNode(), `The path "${path}" has a "." or ".." segment`, {
			itemIndex,
			description: 'Use the path from the space root, e.g. "contracts/2024/offer.pdf".',
		});
	}
	return path;
}

function filePath(this: IExecuteFunctions, name: string, itemIndex: number): string {
	const value = textParam(this.getNodeParameter(name, itemIndex)).trim().replace(/^\/+/, '');
	return plainPath.call(this, value, itemIndex);
}

function spacePath(this: IExecuteFunctions, itemIndex: number): { spaceId: string; base: string } {
	const spaceId = this.getNodeParameter('space', itemIndex, '', { extractValue: true }) as string;
	return { spaceId, base: `/spaces/${encodeURIComponent(spaceId)}/data` };
}

async function download(
	this: IExecuteFunctions,
	apiPath: string,
	itemIndex: number,
): Promise<INodeExecutionData> {
	const options = this.getNodeParameter('options', itemIndex, {}) as { maxFileSizeMb?: unknown };
	const maxBytes = maxFileBytes(options.maxFileSizeMb);
	const { data, contentType } = await localmindApiDownload.call(
		this,
		{ method: 'GET', path: apiPath, itemIndex },
		maxBytes,
	);
	if (data.length > maxBytes) {
		throw new NodeOperationError(
			this.getNode(),
			`The file is larger than ${megabytes(maxBytes)} ('Max File Size (MB)')`,
			{ itemIndex, description: "Raise 'Max File Size (MB)' in the options to download it." },
		);
	}
	const last = apiPath.split('/').pop() || 'file';
	let decoded = last;
	try {
		decoded = decodeURIComponent(last);
	} catch {
		// Not UTF-8 percent-encoding: the name is kept as it is.
	}
	const fileName = safeFileName(decoded);
	const property = textParam(this.getNodeParameter('binaryPropertyName', itemIndex, 'data'));
	return {
		json: { fileName, size: data.length },
		binary: {
			[property]: await this.helpers.prepareBinaryData(data, fileName, binaryMimeType(contentType)),
		},
	};
}

async function upload(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject> {
	const { spaceId, base } = spacePath.call(this, itemIndex);
	const property = textParam(this.getNodeParameter('binaryPropertyName', itemIndex)).trim();
	const folder = normalizeFolder(this.getNodeParameter('folder', itemIndex, ''));
	const options = this.getNodeParameter('options', itemIndex, {}) as UploadOptions;
	const binary = this.helpers.assertBinaryData(itemIndex, property);
	const ownName = textParam(options.fileName).trim();
	// A slash in 'File Name' would put the file into another folder than 'Folder' says. A name that
	// comes with the binary may carry a path (C:\fakepath\offer.pdf from a browser form): its last
	// part counts.
	let fileName = ownName || binary.fileName?.split(/[/\\]/).pop() || 'file';
	if (ownName && /[/\\]/.test(ownName)) {
		throw new NodeOperationError(this.getNode(), `The file name "${fileName}" has a "/" or "\\"`, {
			itemIndex,
			description: "Give the file name only, and the folder in 'Folder'.",
		});
	}
	// Localmind decides by the extension whether and how it processes a file.
	if (!/\.[^./]+$/.test(fileName) && binary.fileExtension) {
		fileName = `${fileName}.${binary.fileExtension}`;
	}
	const { body, contentType } = multipartBody(
		{ path: plainPath.call(this, folder ? `${folder}/${fileName}` : fileName, itemIndex) },
		{
			field: 'file',
			fileName,
			mimeType: binary.mimeType,
			data: await this.helpers.getBinaryDataBuffer(itemIndex, property),
		},
	);

	// Checked before the upload, so a bad value does not leave a stored file behind.
	const timeout = timeoutMs(
		this.getNode(),
		options.timeoutMinutes,
		itemIndex,
		DEFAULT_UPLOAD_TIMEOUT_MINUTES,
	);
	const uploaded = (await localmindApiRequest.call(this, {
		method: 'POST',
		path: `${base}/upload`,
		body,
		headers: { 'content-type': contentType },
		timeout: UPLOAD_TIMEOUT_MS,
		itemIndex,
	})) as UploadResponse;
	const result: IDataObject = {
		spaceId,
		path: uploaded.relative_path,
		size: uploaded.size,
		renamed: uploaded.renamed ?? false,
		runId: uploaded.job_id ?? null,
	};
	const wait = options.waitForProcessing !== false;
	const deadline = new Deadline(timeout);

	// An archive is extracted into its folder and then deleted; its files are processed one by one.
	if (uploaded.extracted_files?.length) {
		const extractedFiles: IDataObject[] = [];
		for (const path of uploaded.extracted_files) {
			const document = await findDocumentByPath.call(this, spaceId, path, itemIndex);
			if (!document || !wait || pipelineStatus(document) || STORED_ONLY.test(path)) {
				extractedFiles.push(documentResult(path, document));
				continue;
			}
			// One failed or slow file must not cost the results of the others.
			try {
				const ready = await waitForDocument.call(
					this,
					spaceId,
					path,
					deadline,
					itemIndex,
					undefined,
					document,
				);
				extractedFiles.push(documentResult(path, ready));
			} catch (error) {
				// Stop means stop, not "carry on with the next file".
				if (isCancelled(this))
					throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
				extractedFiles.push({
					...documentResult(path, document),
					status: extractedFileStatus(error),
					errorMessage: (error as Error).message,
				});
			}
		}
		return { ...result, documentId: null, status: 'extracted', extractedFiles };
	}

	if (uploaded.job_id && wait && !STORED_ONLY.test(uploaded.relative_path)) {
		const document = await waitForDocument.call(
			this,
			spaceId,
			uploaded.relative_path,
			deadline,
			itemIndex,
			uploaded.job_id,
		);
		return {
			...result,
			documentId: document.id,
			status: uploadStatus(document, uploaded.relative_path),
		};
	}
	// Without waiting, or for files Localmind only stores (audio, HTML, skills).
	const document = await findDocumentByPath.call(this, spaceId, uploaded.relative_path, itemIndex);
	return {
		...result,
		documentId: document?.id ?? null,
		status: uploaded.job_id && !STORED_ONLY.test(uploaded.relative_path) ? 'processing' : 'stored',
	};
}

/**
 * The status of an uploaded file: "completed", "failed", "processing", or "stored" for files
 * Localmind only stores (its own word for them, "stored_only", is reported as "stored" too).
 */
function uploadStatus(document: LocalmindDocument | undefined, path: string): string {
	const status = document && pipelineStatus(document);
	if (status === 'stored_only' || STORED_ONLY.test(path) || !document) return 'stored';
	return status ?? 'processing';
}

/** How an uploaded or extracted file ended up: its document and processing state, if any. */
function documentResult(path: string, document: LocalmindDocument | undefined): IDataObject {
	return { path, documentId: document?.id ?? null, status: uploadStatus(document, path) };
}

/** Why waiting for an extracted file ended: a timeout, failed processing, or something else. */
function extractedFileStatus(error: unknown): string {
	if (error instanceof NodeOperationError) return 'processing';
	if ((error as { context?: { processingFailed?: boolean } }).context?.processingFailed)
		return 'failed';
	return 'unknown';
}

export async function executeFile(
	this: IExecuteFunctions,
	operation: string,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	switch (operation) {
		case 'upload':
			return [{ json: await upload.call(this, itemIndex) }];

		case 'list': {
			const { spaceId } = spacePath.call(this, itemIndex);
			const folder = plainPath.call(
				this,
				normalizeFolder(this.getNodeParameter('folder', itemIndex, '')),
				itemIndex,
			);
			const recursive = this.getNodeParameter('includeSubfolders', itemIndex, false) as boolean;
			const entries = await listEntries.call(this, spaceId, folder, itemIndex);
			return entriesIn(entries, folder, recursive).map((entry) => ({
				json: {
					name: entry.name,
					path: entry.path,
					type: entry.type,
					size: entry.size ?? null,
					lastModified: entry.last_modified ?? null,
					readOnly: (entry.read_only ?? false) || isLinked(entry),
				},
			}));
		}

		case 'download': {
			const { base } = spacePath.call(this, itemIndex);
			const path = filePath.call(this, 'path', itemIndex);
			const { url } = (await localmindApiRequest.call(this, {
				method: 'GET',
				path: `${base}/download`,
				qs: { path },
				itemIndex,
			})) as { url: string };
			// The link may name another host than the credential; fetch its path from the API URL.
			const apiPath = downloadLinkPath(url, 'raw');
			if (!apiPath) {
				throw new NodeOperationError(this.getNode(), 'Localmind returned no download link', {
					itemIndex,
					description:
						'Check with File → List that the file exists under this path, then try again.',
				});
			}
			return [await download.call(this, apiPath, itemIndex)];
		}

		case 'downloadByUrl': {
			const url = textParam(this.getNodeParameter('url', itemIndex)).trim();
			const apiPath = downloadLinkPath(url, 'auto');
			if (!apiPath && isDownloadLink(url)) {
				throw new NodeOperationError(this.getNode(), `The download link "${url}" is refused`, {
					itemIndex,
					description: `${UNSAFE_LINK_REFUSAL}. Use the link as Localmind returned it.`,
				});
			}
			if (!apiPath) {
				throw new NodeOperationError(this.getNode(), `"${url}" is not a Localmind download link`, {
					itemIndex,
					description:
						"A download link's path leads to /v1/storage/download/, as in the links Localmind returns. The file is always fetched from the credential's API URL.",
				});
			}
			return [await download.call(this, apiPath, itemIndex)];
		}

		case 'move': {
			const { base } = spacePath.call(this, itemIndex);
			const oldPath = filePath.call(this, 'path', itemIndex);
			const newPath = filePath.call(this, 'newPath', itemIndex);
			await localmindApiRequest.call(this, {
				method: 'PATCH',
				path: `${base}/rename`,
				body: { old_path: oldPath, new_path: newPath },
				itemIndex,
			});
			return [{ json: { moved: true, oldPath, newPath } }];
		}

		case 'delete': {
			const { base } = spacePath.call(this, itemIndex);
			const path = filePath.call(this, 'path', itemIndex);
			await localmindApiRequest.call(this, {
				method: 'DELETE',
				path: `${base}/files`,
				qs: { path },
				itemIndex,
			});
			return [{ json: { deleted: true, path } }];
		}
	}

	throw new NodeOperationError(this.getNode(), `Unknown file operation "${operation}"`, {
		itemIndex,
	});
}
