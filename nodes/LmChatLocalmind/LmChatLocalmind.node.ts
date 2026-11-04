import type {
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { supplyModel } from '@n8n/ai-node-sdk';

import { agentLocator, searchAgents } from '../shared/agents';
import { completionTimeoutMs } from '../shared/polling';
import { localmindApiRequest, localmindApiStream } from '../shared/transport';
import { LocalmindChatModel, type ChatCompletionResponse } from './model';

interface ModelOptions {
	maxTokens?: number;
	temperature?: number;
	timeoutMinutes?: unknown;
}

export class LmChatLocalmind implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Localmind Chat Model',
		name: 'lmChatLocalmind',
		icon: { light: 'file:../../icons/localmind.svg', dark: 'file:../../icons/localmind.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{ $parameter["agent"]?.cachedResultName || $parameter["agent"]?.value }}',
		description: 'Use a Localmind agent as the chat model of an n8n AI Agent or chain',
		defaults: {
			name: 'Localmind Chat Model',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.AiLanguageModel],
		outputNames: ['Model'],
		credentials: [
			{
				name: 'localmindApi',
				required: true,
			},
		],
		properties: [
			{
				displayName:
					'The Localmind agent answers with its own knowledge and tools. Tools connected to the n8n AI Agent are not supported (an output parser works). Files the agent generates are not returned, and images and Office files from the chat do not reach the agent: use the Localmind node for those. The AI Agent takes the agent from the first item only; for a different agent per item, use Loop Over Items.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			agentLocator,
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Maximum Number of Tokens',
						name: 'maxTokens',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 1024,
						description:
							'The maximum number of tokens per model call of the agent. Graph Agents use their own settings and ignore it.',
					},
					{
						displayName: 'Sampling Temperature',
						name: 'temperature',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 1 },
						default: 0.7,
						description:
							'Controls randomness: lower values give more focused and repeatable answers',
					},
					{
						displayName: 'Timeout (Minutes)',
						name: 'timeoutMinutes',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 10 },
						default: 10,
						description:
							'How long to wait for the agent to answer. Localmind stops an answer after 10 minutes.',
					},
				],
			},
		],
	};

	methods = {
		listSearch: {
			searchAgents,
		},
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const agentId = this.getNodeParameter('agent', itemIndex, '', { extractValue: true }) as string;
		const options = this.getNodeParameter('options', itemIndex, {}) as ModelOptions;
		const timeout = completionTimeoutMs(this.getNode(), options.timeoutMinutes, itemIndex);

		const model = new LocalmindChatModel(
			agentId,
			this.getNode(),
			{
				complete: async (body) =>
					(await localmindApiRequest.call(this, {
						method: 'POST',
						path: '/chat/completions',
						body: { ...body },
						timeout,
						// Without streaming, a graph agent can hit the rate limit after its first tools
						// ran; a retry would repeat them. A streaming request gets its 429 before that.
						retryRateLimited: false,
					})) as ChatCompletionResponse,
				stream: async (body) =>
					await localmindApiStream.call(this, {
						method: 'POST',
						path: '/chat/completions',
						body: { ...body },
						timeout,
					}),
			},
			{ maxTokens: options.maxTokens, temperature: options.temperature },
		);

		return supplyModel(this, model);
	}
}
