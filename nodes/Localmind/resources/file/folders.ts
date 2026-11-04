import type { IExecuteFunctions, ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';

import { normalizeFolder, UUID } from '../../../shared/params';
import { localmindApiRequest } from '../../../shared/transport';

/** An entry of a space's file manager, as `GET /v1/spaces/{id}/data/files` lists it. */
export interface FileEntry {
	name: string;
	path: string;
	type: 'file' | 'folder' | 'table' | string;
	size?: number | null;
	last_modified?: string | null;
	content_type?: string | null;
	read_only?: boolean;
	/** A folder linked from another space's library; read-only, at "@linked-<id>/<name>/". */
	linked?: boolean;
	stored_only?: boolean;
}

/**
 * The entries directly in a folder, or (with `recursive`) in it and its subfolders. The API lists
 * recursively and also returns the folder's ancestors, so the node narrows the list itself.
 */
export const isLinked = (entry: FileEntry) =>
	entry.linked === true || entry.path.startsWith('@linked-');

// A linked folder sits at the top level although its path has two segments.
const LINKED_ROOT = /^@linked-[^/]+\/[^/]+\/?$/;

export function entriesIn(entries: FileEntry[], folder: string, recursive: boolean): FileEntry[] {
	const prefix = folder ? `${folder}/` : '';
	return entries.filter((entry) => {
		if (!entry.path.startsWith(prefix)) return false;
		const rest = entry.path.slice(prefix.length).replace(/\/$/, '');
		if (!folder && LINKED_ROOT.test(entry.path)) return true;
		return rest !== '' && (recursive || !rest.includes('/'));
	});
}

export async function listEntries(
	this: ILoadOptionsFunctions | IExecuteFunctions,
	spaceId: string,
	folder: string,
	itemIndex?: number,
): Promise<FileEntry[]> {
	const response = (await localmindApiRequest.call(this, {
		method: 'GET',
		path: `/spaces/${encodeURIComponent(spaceId)}/data/files`,
		qs: folder ? { prefix: `${folder}/` } : {},
		itemIndex,
	})) as { files?: FileEntry[] };
	return response.files ?? [];
}

/** loadOptions method behind the folder dropdowns: the file manager's folders of the chosen space. */
export async function getFolders(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const root = { name: '/ (Top Level)', value: '' };
	const spaceId = this.getCurrentNodeParameter('space', { extractValue: true }) as
		| string
		| undefined;
	// A space set by expression arrives here as its unresolved text: no folders to list then.
	if (!spaceId || !new RegExp(UUID).test(spaceId)) return [root];
	const folders = new Set(
		(await listEntries.call(this, spaceId, ''))
			// Linked library folders and read-only folders refuse uploads.
			.filter((entry) => entry.type === 'folder' && !isLinked(entry) && !entry.read_only)
			.map((entry) => normalizeFolder(entry.path))
			.filter(Boolean),
	);
	return [root, ...[...folders].sort().map((folder) => ({ name: folder, value: folder }))];
}
