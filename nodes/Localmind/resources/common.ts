import type { IExecuteFunctions, INodeProperties } from 'n8n-workflow';

/** "Return All" and "Limit" for a list operation. */
export function paginationProperties(resource: string, operation: string): INodeProperties[] {
	const show = { resource: [resource], operation: [operation] };
	return [
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			displayOptions: { show },
			default: false,
			description: 'Whether to return all results or only up to a given limit',
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			displayOptions: { show: { ...show, returnAll: [false] } },
			typeOptions: { minValue: 1 },
			default: 50,
			description: 'Max number of results to return',
		},
	];
}

/** The item limit of a list operation, or undefined for "Return All". */
export function getLimit(this: IExecuteFunctions, itemIndex: number): number | undefined {
	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	return returnAll ? undefined : (this.getNodeParameter('limit', itemIndex, 50) as number);
}
