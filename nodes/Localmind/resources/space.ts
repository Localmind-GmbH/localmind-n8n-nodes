import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { localmindApiRequestAllItems } from '../../shared/transport';
import { getLimit, paginationProperties } from './common';

export const spaceProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['space'] } },
		options: [
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'List the spaces the API key can access',
				action: 'Get many spaces',
			},
		],
		default: 'getAll',
	},
	...paginationProperties('space', 'getAll'),
];

export async function executeSpace(
	this: IExecuteFunctions,
	operation: string,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	if (operation === 'getAll') {
		const spaces = await localmindApiRequestAllItems.call(
			this,
			{
				method: 'POST',
				path: '/spaces/search',
				// Without an order, pages of LIMIT/OFFSET can repeat or skip spaces.
				body: { filters: {}, order_by: ['name', 'id'] },
				idempotent: true,
				itemIndex,
			},
			getLimit.call(this, itemIndex),
		);
		return (spaces as IDataObject[]).map((json) => ({ json }));
	}

	throw new NodeOperationError(this.getNode(), `Unknown space operation "${operation}"`, {
		itemIndex,
	});
}
