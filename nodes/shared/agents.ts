import type {
	ILoadOptionsFunctions,
	INodeListSearchResult,
	INodeProperties,
	INodePropertyOptions,
} from 'n8n-workflow';

import { UUID } from './params';
import { localmindApiRequest, type LocalmindContext } from './transport';

/** An agent as `GET /v1/models` lists it: every agent the API key can use, ordered by name. */
export interface AgentModel {
	id: string;
	name?: string;
	created?: number;
	owned_by?: string;
}

/** Lists the agents the API key can use. The endpoint is not paginated. */
export async function listAgents(this: LocalmindContext): Promise<AgentModel[]> {
	const response = (await localmindApiRequest.call(this, { method: 'GET', path: '/models' })) as {
		data?: AgentModel[];
	};
	return response.data ?? [];
}

/** listSearch method behind the agent dropdowns. */
export async function searchAgents(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const agents = await listAgents.call(this);
	const needle = filter?.trim().toLowerCase();
	return {
		results: agents
			.filter(
				(agent) =>
					!needle || agent.id === needle || (agent.name ?? '').toLowerCase().includes(needle),
			)
			.map((agent) => ({ name: agent.name ?? agent.id, value: agent.id })),
	};
}

/** loadOptions method for plain agent dropdowns, such as list filters. */
export async function getAgents(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const agents = await listAgents.call(this);
	return agents.map((agent) => ({ name: agent.name ?? agent.id, value: agent.id }));
}

/** The agent picker: a searchable list of the key's agents, or an agent ID. */
export const agentLocator: INodeProperties = {
	displayName: 'Agent',
	name: 'agent',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	description: 'The Localmind agent. The list shows the agents the API key can use.',
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: { searchListMethod: 'searchAgents', searchable: true },
		},
		{
			displayName: 'ID',
			name: 'id',
			type: 'string',
			placeholder: 'e.g. 0b6f6c1e-8d1a-4c9e-9f3b-2a7d5e4c1b90',
			validation: [
				{ type: 'regex', properties: { regex: UUID, errorMessage: 'Enter a valid agent ID' } },
			],
		},
	],
};
