import type { ILoadOptionsFunctions, INodeListSearchResult, INodeProperties } from 'n8n-workflow';

import { UUID } from '../../../shared/params';
import { localmindApiRequest, type Page } from '../../../shared/transport';

const PAGE_SIZE = 50;

/** listSearch method behind the conversation picker: the key owner's conversations, newest first. */
export async function searchConversations(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const page = paginationToken ? Number(paginationToken) : 1;
	const needle = filter?.trim();
	const result = (await localmindApiRequest.call(this, {
		method: 'POST',
		path: '/conversations/search',
		qs: { page, limit: PAGE_SIZE },
		body: {
			filters: needle ? { title__contains: needle } : {},
			order_by: ['-last_message_at', 'id'],
		},
		idempotent: true,
	})) as Page<{ id: string; title?: string }>;
	return {
		results: result.items.map((conversation) => ({
			name: conversation.title || conversation.id,
			value: conversation.id,
		})),
		paginationToken: page < result.total_pages ? String(page + 1) : undefined,
	};
}

/** The conversation picker: a searchable list of the key owner's conversations, or an ID. */
export const conversationLocator: INodeProperties = {
	displayName: 'Conversation',
	name: 'conversation',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	description: 'The Localmind conversation',
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: { searchListMethod: 'searchConversations', searchable: true },
		},
		{
			displayName: 'ID',
			name: 'id',
			type: 'string',
			placeholder: 'e.g. 9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d',
			validation: [
				{
					type: 'regex',
					properties: { regex: UUID, errorMessage: 'Enter a valid conversation ID' },
				},
			],
		},
	],
};
