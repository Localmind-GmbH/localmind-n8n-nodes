import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError, jsonParse } from 'n8n-workflow';

import type { LocalmindDocument } from '../../../shared/documents';
import { documentsAtPath, storedPath } from '../../../shared/documents';
import { commaList, idParam, normalizeFolder, textParam } from '../../../shared/params';
import { localmindApiRequest, localmindApiRequestAllItems } from '../../../shared/transport';
import { getLimit } from '../common';
import { simplifyDocument } from '../simplify';

interface SearchOptions {
	documentIds?: string;
	folders?: string;
	minScore?: number;
	semanticWeight?: number;
}

interface DocumentFilters {
	fileTypes?: string[];
	folder?: string;
	name?: string;
	spaceId?: string;
}

interface SearchResult {
	chunk_id?: string;
	document_id?: string;
	document_name?: string;
	folder_path?: string | null;
	file_type?: string;
	chunk_index?: number;
	text?: string;
	score?: number;
	metadata?: IDataObject | null;
}

interface ContentUnit {
	unit_index: number;
	unit_type?: string;
	text?: string | null;
	unit_metadata?: IDataObject | null;
}

interface FolderTreeNode {
	name?: string;
	path?: string;
	type?: string;
	document_id?: string;
	children?: FolderTreeNode[];
}

/**
 * The given documents that lie in the given folders, matched by Localmind itself (on the stored
 * path, which can differ from the file name). Hybrid search alone searches the whole space when
 * none of them does.
 */
async function documentsInFolders(
	this: IExecuteFunctions,
	spaceId: string,
	documentIds: string[],
	folders: string[],
	itemIndex: number,
): Promise<string[]> {
	const response = (await localmindApiRequest.call(this, {
		method: 'POST',
		path: '/data/search/folders',
		body: { space_id: spaceId, folders },
		idempotent: true,
		itemIndex,
	})) as { document_ids?: string[] };
	const inFolders = new Set((response.document_ids ?? []).map((id) => id.toLowerCase()));
	return documentIds.filter((id) => inFolders.has(id));
}

function documentOutput(
	this: IExecuteFunctions,
	document: LocalmindDocument,
	itemIndex: number,
): IDataObject {
	const simplify = this.getNodeParameter('simplify', itemIndex, true) as boolean;
	return simplify
		? simplifyDocument(document as LocalmindDocument & IDataObject)
		: (document as unknown as IDataObject);
}

/** Metadata keys Localmind writes itself; a metadata update keeps them. */
const SYSTEM_METADATA_KEYS = new Set([
	'original_filename',
	'content_type',
	'uploaded_at',
	'ingested_at',
	'source',
]);

/** Metadata after applying an update: changed and new fields set, null fields removed, Localmind's own fields kept as they are. */
export function mergeMetadata(current: IDataObject, update: IDataObject): IDataObject {
	const merged: IDataObject = { ...current };
	for (const [key, value] of Object.entries(update)) {
		if (SYSTEM_METADATA_KEYS.has(key)) continue;
		if (value === null) {
			delete merged[key];
		} else {
			// Not merged[key] = …: a "__proto__" key would set the prototype instead of a field.
			Object.defineProperty(merged, key, {
				value,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
	}
	return merged;
}

/** The file-manager path of a document in the space's folder tree, if it has one. */
export function pathInTree(
	tree: { folders?: FolderTreeNode[] },
	documentId: string,
): string | undefined {
	for (const root of tree.folders ?? []) {
		const found = pathInFolder(root, documentId);
		if (found) return found;
	}
	return undefined;
}

function pathInFolder(tree: FolderTreeNode, documentId: string): string | undefined {
	const walk = (node: FolderTreeNode, folder: string): string | undefined => {
		for (const child of node.children ?? []) {
			if (child.type === 'file' && child.document_id === documentId && child.name) {
				return folder ? `${folder}/${child.name}` : child.name;
			}
			if (child.type === 'folder') {
				const found = walk(child, child.path && child.path !== '/' ? child.path : folder);
				if (found) return found;
			}
		}
		return undefined;
	};
	return walk(tree, tree.path && tree.path !== '/' ? tree.path : '');
}

function documentId(this: IExecuteFunctions, itemIndex: number): string {
	return this.getNodeParameter('document', itemIndex, '', { extractValue: true }) as string;
}

async function getDocument(
	this: IExecuteFunctions,
	id: string,
	itemIndex: number,
): Promise<LocalmindDocument> {
	return (await localmindApiRequest.call(this, {
		method: 'GET',
		path: `/data/${encodeURIComponent(id)}`,
		itemIndex,
	})) as LocalmindDocument;
}

/** The document's current file-manager path, confirmed by looking the document up by it. */
async function fileManagerPath(
	this: IExecuteFunctions,
	document: LocalmindDocument,
	itemIndex: number,
): Promise<string | undefined> {
	// The file-manager delete removes every document under the path, so the path must hold
	// exactly this one; otherwise another document would be deleted with it.
	const isPathOf = async (path: string | undefined) => {
		if (!path) return false;
		const documents = await documentsAtPath.call(this, document.space_id, path, itemIndex, 2);
		return documents.length === 1 && documents[0].id === document.id;
	};

	// Cheap first: the path the file was uploaded to, unless it was moved since.
	const stored = storedPath(document);
	if (await isPathOf(stored)) return stored;

	const tree = (await localmindApiRequest.call(this, {
		method: 'GET',
		path: `/data/folders/${encodeURIComponent(document.space_id)}`,
		qs: { include_files: true },
		itemIndex,
	})) as { folders?: FolderTreeNode[] };
	const found = pathInTree(tree, document.id);
	return (await isPathOf(found)) ? found : undefined;
}

/**
 * Deletes a document with its stored file and search index.
 *
 * `DELETE /v1/data/{id}` removes only the database record and leaves the file and the vectors
 * behind, so the node finds the document's file-manager path and deletes the file there, which
 * removes all three. A document without a file in the file manager falls back to the record.
 */
async function deleteDocument(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject> {
	const id = documentId.call(this, itemIndex);
	const document = await getDocument.call(this, id, itemIndex);
	// Without a stored file, the file manager cannot delete it (the backend answers 500).
	const candidate = document.source_file_deleted
		? undefined
		: await fileManagerPath.call(this, document, itemIndex);

	if (candidate) {
		await localmindApiRequest.call(this, {
			method: 'DELETE',
			path: `/spaces/${encodeURIComponent(document.space_id)}/data/files`,
			qs: { path: candidate },
			itemIndex,
		});
		return { deleted: true, documentId: id, path: candidate, recordOnly: false };
	}

	await localmindApiRequest.call(this, {
		method: 'DELETE',
		path: `/data/${encodeURIComponent(id)}`,
		itemIndex,
	});
	// Localmind's record delete leaves the stored file and the search entries behind.
	this.addExecutionHints({
		message: document.source_file_deleted
			? 'Only the document record was deleted: Localmind had already removed the stored file, but its search entries can remain.'
			: 'Only the document record was deleted: the file was not found in the file manager, so its stored file and search entries remain.',
		location: 'outputPane',
	});
	return { deleted: true, documentId: id, path: null, recordOnly: true };
}

export async function executeDocument(
	this: IExecuteFunctions,
	operation: string,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	switch (operation) {
		case 'search': {
			const spaceId = idParam(
				this.getNodeParameter('space', itemIndex, '', { extractValue: true }),
			);
			const query = textParam(this.getNodeParameter('query', itemIndex));
			const options = this.getNodeParameter('options', itemIndex, {}) as SearchOptions;
			const limit = this.getNodeParameter('limit', itemIndex, 50) as number;
			const semanticWeight = options.semanticWeight ?? 0.7;
			// Localmind compares document IDs case-sensitively, and its IDs are lowercase.
			let documentIds = commaList(options.documentIds).map((id) => idParam(id));
			// The backend matches no document for a folder pattern with a trailing slash.
			let folders = commaList(options.folders).map((folder) => normalizeFolder(folder) || '/');
			if (documentIds.length && folders.length) {
				documentIds = await documentsInFolders.call(this, spaceId, documentIds, folders, itemIndex);
				folders = [];
				if (!documentIds.length) {
					this.addExecutionHints({
						message: 'None of the given documents lies in the given folders',
						location: 'outputPane',
					});
					return [];
				}
			}
			const response = (await localmindApiRequest.call(this, {
				method: 'POST',
				path: '/data/hybrid-search',
				body: {
					space_id: spaceId,
					query,
					top_k: limit,
					// The API requires both weights to add up to 1.
					dense_weight: semanticWeight,
					sparse_weight: Math.round((1 - semanticWeight) * 1000) / 1000,
					...(documentIds.length && { document_ids: documentIds }),
					...(folders.length && { folders }),
				},
				idempotent: true,
				itemIndex,
			})) as { results?: SearchResult[]; message?: string | null };
			if (!response.results?.length && response.message) {
				this.addExecutionHints({
					message: `Localmind: ${response.message}`,
					location: 'outputPane',
				});
			}
			return (response.results ?? [])
				.filter((result) => (result.score ?? 0) >= (options.minScore ?? 0))
				.map((result) => ({
					json: {
						documentId: result.document_id,
						documentName: result.document_name,
						folderPath: result.folder_path,
						text: result.text,
						score: result.score,
						fileType: result.file_type,
						chunkId: result.chunk_id,
						chunkIndex: result.chunk_index,
						metadata: result.metadata,
					},
				}));
		}

		case 'get': {
			const document = await getDocument.call(this, documentId.call(this, itemIndex), itemIndex);
			return [{ json: documentOutput.call(this, document, itemIndex) }];
		}

		case 'getAll': {
			const filters = this.getNodeParameter('filters', itemIndex, {}) as DocumentFilters;
			const folder = normalizeFolder(filters.folder);
			const documents = await localmindApiRequestAllItems.call(
				this,
				{
					method: 'POST',
					path: '/data/search',
					body: {
						filters: {
							...(filters.spaceId && { space_id: idParam(filters.spaceId) }),
							...(filters.fileTypes?.length && { file_type__in: filters.fileTypes }),
							...(folder && { user_path__startswith: `${folder}/` }),
							...(filters.name && { user_path__contains: textParam(filters.name) }),
						},
						order_by: ['-created_at', 'id'],
					},
					idempotent: true,
					itemIndex,
				},
				getLimit.call(this, itemIndex),
			);
			return (documents as LocalmindDocument[]).map((document) => ({
				json: documentOutput.call(this, document, itemIndex),
			}));
		}

		case 'getText': {
			const id = documentId.call(this, itemIndex);
			const response = (await localmindApiRequest.call(this, {
				method: 'GET',
				path: `/data/${encodeURIComponent(id)}/text`,
				itemIndex,
			})) as { content_units?: ContentUnit[] };
			const units = [...(response.content_units ?? [])].sort((a, b) => a.unit_index - b.unit_index);
			if (this.getNodeParameter('textOutput', itemIndex, 'joined') === 'units') {
				return units.map((unit) => ({
					json: {
						documentId: id,
						index: unit.unit_index,
						type: unit.unit_type,
						text: unit.text ?? '',
						metadata: unit.unit_metadata ?? {},
					},
				}));
			}
			const text = units
				.map((unit) => unit.text ?? '')
				.filter(Boolean)
				.join('\n\n');
			return [{ json: { documentId: id, text, units: units.length } }];
		}

		case 'getChunks': {
			const id = documentId.call(this, itemIndex);
			const response = (await localmindApiRequest.call(this, {
				method: 'GET',
				path: `/data/${encodeURIComponent(id)}/chunks`,
				itemIndex,
			})) as { chunks?: IDataObject[] };
			return (response.chunks ?? []).map((json) => ({ json }));
		}

		case 'reprocess': {
			const id = documentId.call(this, itemIndex);
			const response = (await localmindApiRequest.call(this, {
				method: 'POST',
				path: `/data/${encodeURIComponent(id)}/reprocess`,
				body: {},
				itemIndex,
			})) as IDataObject;
			return [
				{
					json: {
						documentId: id,
						runId: response.pipeline_run_id,
						versionNumber: response.version_number,
						message: response.message,
					},
				},
			];
		}

		case 'updateMetadata': {
			const id = documentId.call(this, itemIndex);
			const raw = this.getNodeParameter('metadata', itemIndex, '{}');
			const update =
				typeof raw === 'string'
					? jsonParse<IDataObject>(raw, { errorMessage: 'Metadata is not valid JSON' })
					: (raw as IDataObject);
			if (typeof update !== 'object' || update === null || Array.isArray(update)) {
				throw new NodeOperationError(this.getNode(), 'Metadata must be a JSON object', {
					itemIndex,
				});
			}
			if (Object.keys(update).length === 0) {
				throw new NodeOperationError(
					this.getNode(),
					'Metadata is empty: there is nothing to update',
					{
						itemIndex,
						description:
							'Enter the fields to add or change, e.g. { "project": "Q3" }; set a field to null to remove it.',
					},
				);
			}
			// The API replaces the whole metadata field, so the node merges into the current one.
			const document = await getDocument.call(this, id, itemIndex);
			const updated = await localmindApiRequest.call(this, {
				method: 'PATCH',
				path: `/data/${encodeURIComponent(id)}`,
				body: { doc_metadata: mergeMetadata(document.doc_metadata ?? {}, update) },
				itemIndex,
			});
			return [{ json: documentOutput.call(this, updated as LocalmindDocument, itemIndex) }];
		}

		case 'delete':
			return [{ json: await deleteDocument.call(this, itemIndex) }];
	}

	throw new NodeOperationError(this.getNode(), `Unknown document operation "${operation}"`, {
		itemIndex,
	});
}
