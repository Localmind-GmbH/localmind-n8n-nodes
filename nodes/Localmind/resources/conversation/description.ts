import type { INodeProperties } from 'n8n-workflow';

import { agentLocator } from '../../../shared/agents';
import { spaceLocator } from '../../../shared/spaces';
import { paginationProperties } from '../common';
import { conversationLocator } from './search';
import { simplifyProperty } from '../simplify';

const showFor = (operation: string[]) => ({ show: { resource: ['conversation'], operation } });

export const conversationProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['conversation'] } },
		options: [
			{
				name: 'Create',
				value: 'create',
				description: 'Start a conversation with an agent in a space',
				action: 'Create a conversation',
			},
			{
				name: 'Delete',
				value: 'delete',
				description: 'Delete a conversation',
				action: 'Delete a conversation',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Get a conversation',
				action: 'Get a conversation',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'List conversations of the API key owner',
				action: 'Get many conversations',
			},
			{
				name: 'Get Messages',
				value: 'getMessages',
				description: 'Get all messages of a conversation',
				action: 'Get messages of a conversation',
			},
			{
				name: 'Send Message',
				value: 'sendMessage',
				description: 'Send a message and wait for the agent to answer',
				action: 'Send a message to a conversation',
			},
		],
		default: 'sendMessage',
	},

	// Create
	{ ...agentLocator, displayOptions: showFor(['create']) },
	{ ...spaceLocator, displayOptions: showFor(['create']) },
	{
		displayName: 'Title',
		name: 'title',
		type: 'string',
		default: '',
		displayOptions: showFor(['create']),
		description: 'Leave empty to let Localmind title the conversation after its first message',
	},

	// Get, Delete, Get Messages, Send Message
	{
		...conversationLocator,
		displayOptions: showFor(['get', 'delete', 'getMessages', 'sendMessage']),
	},

	// Get Many
	...paginationProperties('conversation', 'getAll'),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: showFor(['getAll']),
		options: [
			{
				displayName: 'Agent Name or ID',
				name: 'agentId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getAgents' },
				default: '',
				description:
					'Only conversations with this agent. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Include Shared With Me',
				name: 'includeSharedWithMe',
				type: 'boolean',
				default: false,
				description:
					'Whether to include conversations that others shared with the key owner. Has no effect together with Search Text.',
			},
			{
				displayName: 'Search Text',
				name: 'search',
				type: 'string',
				default: '',
				description: 'Text to find in the title or in any message of the conversation',
			},
			{
				displayName: 'Space Name or ID',
				name: 'spaceId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getSpaces' },
				default: '',
				description:
					'Only conversations in this space. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Title Contains',
				name: 'title',
				type: 'string',
				default: '',
				description: 'Text the title contains, ignoring case',
			},
		],
	},

	// Get Messages
	simplifyProperty('conversation', ['create', 'get', 'getAll', 'getMessages']),

	// Send Message
	{
		displayName:
			'Send Message keeps the history and waits when all code sandboxes are busy. For one answer with your own system message, temperature or JSON output, or, before Localmind 1.7.0, to give the agent PDF or Office documents, use Agent → Ask.',
		name: 'sendMessageNotice',
		type: 'notice',
		default: '',
		displayOptions: showFor(['sendMessage']),
	},
	{
		displayName: 'Message',
		name: 'message',
		type: 'string',
		typeOptions: { rows: 4 },
		required: true,
		default: '',
		displayOptions: showFor(['sendMessage']),
		description: 'The message to the agent, at most 50,000 characters',
	},
	{
		displayName: 'Wait for Answer',
		name: 'waitForAnswer',
		type: 'boolean',
		default: true,
		displayOptions: showFor(['sendMessage']),
		description:
			'Whether to wait until the agent has answered. When off, the node returns at once with the IDs to read the answer later with Get Messages.',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: showFor(['sendMessage']),
		options: [
			{
				displayName: 'Attachments',
				name: 'attachments',
				type: 'string',
				default: 'data',
				placeholder: 'e.g. data, invoice',
				description:
					'Names of the input binary fields to attach, separated by commas. JPEG, PNG, GIF and WebP images go to the model. From Localmind 1.7.0, other files (PDF, Office, CSV, …) are uploaded for the conversation, and the agent gets their text and the original in its code sandbox; a text file of a type the space does not take goes along as text. Before 1.7.0, images and text files only.',
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
				displayName: 'Disabled Tool IDs',
				name: 'disabledToolIds',
				type: 'string',
				default: '',
				placeholder: 'e.g. 3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b',
				description:
					"IDs of tools the agent must not use, separated by commas, as Agent → Get lists them under 'toolIds'. Skills count as tools; turning off all of them also turns off code execution. Unknown IDs are ignored. Replaces the conversation's current setting; leave empty to allow all tools again.",
			},
			{
				displayName: 'Download Files',
				name: 'downloadFiles',
				type: 'boolean',
				default: true,
				description:
					'Whether to download the files the agent generates as binary data (file_0, file_1, …). Applies when waiting for the answer. As a tool of an AI Agent, files are only downloaded when this is switched on explicitly.',
			},
			{
				displayName: 'Include Tool Calls',
				name: 'includeToolCalls',
				type: 'boolean',
				default: false,
				description: 'Whether to add the tool calls the agent made to the output',
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
				displayName: 'Timeout (Minutes)',
				name: 'timeoutMinutes',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 1440 },
				default: 15,
				description:
					'How long to wait for the answer. After a timeout the agent keeps working in Localmind, and the error says what it was doing. Processing the attachments before the message is sent has a wait of the same length of its own.',
			},
		],
	},
];
