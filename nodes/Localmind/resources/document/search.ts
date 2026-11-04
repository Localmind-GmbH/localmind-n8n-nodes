import type { ILoadOptionsFunctions, INodeListSearchResult, INodeProperties } from 'n8n-workflow';

import { UUID } from '../../../shared/params';
import type { LocalmindDocument } from '../../../shared/documents';
import { localmindApiRequest, type Page } from '../../../shared/transport';

const PAGE_SIZE = 50;

/** A document's name for people: its original file name, else its ID. */
export function documentName(document: LocalmindDocument): string {
	const name = document.doc_metadata?.original_filename;
	return typeof name === 'string' && name ? name : document.id;
}

/** listSearch method behind the document picker: documents the key can read, newest first. */
export async function searchDocuments(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const page = paginationToken ? Number(paginationToken) : 1;
	const needle = filter?.trim();
	const result = (await localmindApiRequest.call(this, {
		method: 'POST',
		path: '/data/search',
		qs: { page, limit: PAGE_SIZE },
		body: {
			filters: needle ? { user_path__contains: needle } : {},
			order_by: ['-created_at', 'id'],
		},
		idempotent: true,
	})) as Page<LocalmindDocument>;
	return {
		results: result.items.map((document) => ({
			name: documentName(document),
			value: document.id,
		})),
		paginationToken: page < result.total_pages ? String(page + 1) : undefined,
	};
}

/** The document picker: a searchable list of the documents the key can read, or an ID. */
export const documentLocator: INodeProperties = {
	displayName: 'Document',
	name: 'document',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	description: "A document of a space's data pool",
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: { searchListMethod: 'searchDocuments', searchable: true },
		},
		{
			displayName: 'ID',
			name: 'id',
			type: 'string',
			placeholder: 'e.g. 5d9f1c2a-3b4e-4f6a-8b7c-9d0e1f2a3b4c',
			validation: [
				{
					type: 'regex',
					properties: { regex: UUID, errorMessage: 'Enter a valid document ID' },
				},
			],
		},
	],
};
