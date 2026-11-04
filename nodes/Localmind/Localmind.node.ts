import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { getAgents, searchAgents } from '../shared/agents';
import { getSpaces, searchSpaces } from '../shared/spaces';
import { agentProperties } from './resources/agent/description';
import { executeAgent } from './resources/agent/execute';
import { conversationProperties } from './resources/conversation/description';
import { executeConversation } from './resources/conversation/execute';
import { searchConversations } from './resources/conversation/search';
import { documentProperties } from './resources/document/description';
import { executeDocument } from './resources/document/execute';
import { searchDocuments } from './resources/document/search';
import { fileProperties } from './resources/file/description';
import { executeFile } from './resources/file/execute';
import { getFolders } from './resources/file/folders';
import { jobProperties } from './resources/job/description';
import { executeJob } from './resources/job/execute';
import { executeSpace, spaceProperties } from './resources/space';

type ResourceHandler = (
	this: IExecuteFunctions,
	operation: string,
	itemIndex: number,
) => Promise<INodeExecutionData[]>;

const handlers: Record<string, ResourceHandler> = {
	agent: executeAgent,
	conversation: executeConversation,
	document: executeDocument,
	file: executeFile,
	job: executeJob,
	space: executeSpace,
};

// Programmatic rather than declarative: Send Message queues a turn, polls the conversation state
// and returns generated files as binary data, which declarative routing cannot express.
export class Localmind implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Localmind',
		name: 'localmind',
		icon: { light: 'file:../../icons/localmind.svg', dark: 'file:../../icons/localmind.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
		description: 'Work with Localmind agents, conversations, documents and files',
		defaults: {
			name: 'Localmind',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'localmindApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Agent', value: 'agent' },
					{ name: 'Conversation', value: 'conversation' },
					{ name: 'Document', value: 'document' },
					{ name: 'File', value: 'file' },
					{ name: 'Job', value: 'job' },
					{ name: 'Space', value: 'space' },
				],
				default: 'agent',
			},
			...agentProperties,
			...conversationProperties,
			...documentProperties,
			...fileProperties,
			...jobProperties,
			...spaceProperties,
		],
	};

	methods = {
		listSearch: {
			searchAgents,
			searchConversations,
			searchDocuments,
			searchSpaces,
		},
		loadOptions: {
			getAgents,
			getFolders,
			getSpaces,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				const handler = handlers[resource];
				if (!handler) {
					throw new NodeOperationError(this.getNode(), `Unknown resource "${resource}"`, {
						itemIndex: i,
					});
				}
				// A loop rather than push(...results): a spread of a very large list overflows the stack.
				for (const item of await handler.call(this, operation, i)) {
					returnData.push({ ...item, pairedItem: { item: i } });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					// The description carries what is needed to pick up later, e.g. conversation and message IDs.
					const { message, description } = error as { message: string; description?: string };
					// "Continue (using error output)" routes an item whose JSON holds only `error`; n8n would
					// count one with more fields as a success, and an error set on the item itself makes n8n
					// replace the JSON with the bare message. So the description goes into the text there.
					const json =
						this.getNode().onError === 'continueErrorOutput'
							? { error: description ? `${message.replace(/\.?$/, '.')} ${description}` : message }
							: { error: message, ...(description && { description }) };
					returnData.push({ json, pairedItem: { item: i } });
					continue;
				}
				// Re-wrapping returns the same error, so the item has to be set on it directly. The
				// re-wrap stays: n8n's community-node rules forbid re-throwing an error as it is.
				if (error instanceof NodeApiError || error instanceof NodeOperationError) {
					error.context.itemIndex = i;
				}
				if (error instanceof NodeApiError) {
					throw new NodeApiError(this.getNode(), error as unknown as JsonObject, { itemIndex: i });
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
