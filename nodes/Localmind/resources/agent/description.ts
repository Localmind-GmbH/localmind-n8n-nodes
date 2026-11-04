import type { INodeProperties } from 'n8n-workflow';

import { agentLocator } from '../../../shared/agents';
import { paginationProperties } from '../common';
import { simplifyProperty } from '../simplify';

const showFor = (operation: string[]) => ({ show: { resource: ['agent'], operation } });

export const agentProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['agent'] } },
		options: [
			{
				name: 'Ask',
				value: 'ask',
				description: 'Get one answer from an agent, without keeping a conversation',
				action: 'Ask an agent',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Get the configuration of an agent',
				action: 'Get an agent',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'List the agents the API key can use',
				action: 'Get many agents',
			},
		],
		default: 'ask',
	},
	{
		displayName:
			'Ask gets one answer without history. For work that builds on earlier messages, runs in a chosen space, or should wait when all code sandboxes are busy, use Conversation → Send Message.',
		name: 'askNotice',
		type: 'notice',
		default: '',
		displayOptions: showFor(['ask']),
	},
	{ ...agentLocator, displayOptions: showFor(['ask', 'get']) },
	{
		displayName: 'Prompt',
		name: 'prompt',
		type: 'string',
		typeOptions: { rows: 4 },
		required: true,
		default: '',
		displayOptions: showFor(['ask']),
		description: 'The question or task for the agent',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: showFor(['ask']),
		options: [
			{
				displayName: 'Attachments',
				name: 'attachments',
				type: 'string',
				default: 'data',
				placeholder: 'e.g. data, invoice',
				description:
					'Names of the input binary fields to attach, separated by commas. Images go to the vision model; PDF, Office, text and CSV documents are read as text (at most 10 documents).',
			},
			{
				displayName: 'Binary Field Prefix',
				name: 'binaryPropertyPrefix',
				type: 'string',
				default: 'file_',
				description:
					'Prefix of the binary fields for the generated files, followed by a number: file_0, file_1, …',
			},
			{
				displayName: 'Download Files',
				name: 'downloadFiles',
				type: 'boolean',
				default: true,
				description:
					'Whether to download the files the agent generates as binary data (file_0, file_1, …). As a tool of an AI Agent, files are only downloaded when this is switched on explicitly.',
			},
			{
				displayName: 'JSON Output',
				name: 'jsonOutput',
				type: 'boolean',
				default: false,
				description:
					'Whether to ask the model for JSON and parse the answer into the "output" field',
			},
			{
				displayName: 'Max File Size (MB)',
				name: 'maxFileSizeMb',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 50,
				description:
					'Generated files larger than this are not downloaded; they stay listed with their link',
			},
			{
				displayName: 'Max Files to Download',
				name: 'maxFiles',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 10,
				description: 'Further generated files are not downloaded; they stay listed with their link',
			},
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
				description: 'Controls randomness: lower values give more focused and repeatable answers',
			},
			{
				displayName: 'System Message',
				name: 'systemMessage',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				description: "Instructions added to the agent's own for this answer",
			},
			{
				displayName: 'Timeout (Minutes)',
				name: 'timeoutMinutes',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 10 },
				default: 10,
				description:
					'How long to wait for the answer. Localmind stops an answer after 10 minutes; use Conversation → Send Message for longer tasks.',
			},
		],
	},
	...paginationProperties('agent', 'getAll'),
	simplifyProperty('agent', ['get']),
];
