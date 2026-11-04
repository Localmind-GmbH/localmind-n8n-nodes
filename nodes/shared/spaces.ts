import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeListSearchResult,
	INodeProperties,
	INodePropertyOptions,
} from 'n8n-workflow';

import { UUID } from './params';
import { localmindApiRequest, localmindApiRequestAllItems, type Page } from './transport';

interface Space {
	id: string;
	name?: string;
}

/** Spaces per page of the picker, which loads more as the user scrolls. */
const PAGE_SIZE = 50;

const spaceSearch = (filter?: string) => {
	const needle = filter?.trim();
	const filters: IDataObject = needle ? { name__contains: needle } : {};
	return {
		method: 'POST' as const,
		path: '/spaces/search',
		body: { filters, order_by: ['name', 'id'] },
	};
};

async function listSpaces(this: ILoadOptionsFunctions, filter?: string): Promise<Space[]> {
	const spaces = await localmindApiRequestAllItems.call(this, {
		...spaceSearch(filter),
		idempotent: true,
	});
	return spaces as Space[];
}

/** listSearch method behind the space pickers: one page per call, so typing stays fast. */
export async function searchSpaces(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const page = paginationToken ? Number(paginationToken) : 1;
	const result = (await localmindApiRequest.call(this, {
		...spaceSearch(filter),
		qs: { page, limit: PAGE_SIZE },
		idempotent: true,
	})) as Page<Space>;
	return {
		results: result.items.map((space) => ({ name: space.name ?? space.id, value: space.id })),
		paginationToken: page < result.total_pages ? String(page + 1) : undefined,
	};
}

/** loadOptions method for plain space dropdowns, such as list filters. */
export async function getSpaces(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const spaces = await listSpaces.call(this);
	return spaces.map((space) => ({ name: space.name ?? space.id, value: space.id }));
}

/** The space picker: a searchable list of the spaces the key can access, or a space ID. */
export const spaceLocator: INodeProperties = {
	displayName: 'Space',
	name: 'space',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	description: 'The Localmind space. The list shows the spaces the API key can access.',
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: { searchListMethod: 'searchSpaces', searchable: true },
		},
		{
			displayName: 'ID',
			name: 'id',
			type: 'string',
			placeholder: 'e.g. 7c9e6679-7425-40de-944b-e07fc1f90ae7',
			validation: [
				{ type: 'regex', properties: { regex: UUID, errorMessage: 'Enter a valid space ID' } },
			],
		},
	],
};
