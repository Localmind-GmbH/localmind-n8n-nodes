import type { INodeProperties } from 'n8n-workflow';

import { spaceLocator } from '../../../shared/spaces';
import { paginationProperties } from '../common';
import { documentLocator } from './search';
import { simplifyProperty } from '../simplify';

const showFor = (operation: string[]) => ({ show: { resource: ['document'], operation } });

const FILE_TYPES = [
	'AUDIO',
	'CSV',
	'DOC',
	'DOCX',
	'HTML',
	'IMAGE',
	'MARKDOWN',
	'PDF',
	'PPTX',
	'TEXT',
	'VIDEO',
	'WEB_PAGE',
	'XLSX',
	'ZIP',
];

/** A file type in title case for the UI; abbreviations such as PDF stay upper case. */
function fileTypeName(type: string): string {
	const words: Record<string, string> = {
		AUDIO: 'Audio',
		IMAGE: 'Image',
		MARKDOWN: 'Markdown',
		TEXT: 'Text',
		VIDEO: 'Video',
		WEB_PAGE: 'Web Page',
	};
	return words[type] ?? type;
}

export const documentProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['document'] } },
		options: [
			{
				name: 'Delete',
				value: 'delete',
				description: 'Delete a document with its file and search index',
				action: 'Delete a document',
			},
			{ name: 'Get', value: 'get', description: 'Get a document', action: 'Get a document' },
			{
				name: 'Get Chunks',
				value: 'getChunks',
				description: 'Get the chunks a document was split into for search',
				action: 'Get chunks of a document',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'List documents of the data pool',
				action: 'Get many documents',
			},
			{
				name: 'Get Text',
				value: 'getText',
				description: 'Get the text Localmind extracted from a document',
				action: 'Get text of a document',
			},
			{
				name: 'Reprocess',
				value: 'reprocess',
				description: 'Parse, chunk and index a document again',
				action: 'Reprocess a document',
			},
			{
				name: 'Search',
				value: 'search',
				description: "Search a space's documents by meaning and keywords",
				action: 'Search documents',
			},
			{
				name: 'Update Metadata',
				value: 'updateMetadata',
				description: "Add or change fields of a document's metadata",
				action: 'Update metadata of a document',
			},
		],
		default: 'search',
	},

	// Search
	{ ...spaceLocator, displayOptions: showFor(['search']) },
	{
		displayName: 'Query',
		name: 'query',
		type: 'string',
		required: true,
		default: '',
		displayOptions: showFor(['search']),
		description: 'What to search for',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: 100 },
		default: 50,
		displayOptions: showFor(['search']),
		description: 'Max number of results to return',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: showFor(['search']),
		options: [
			{
				displayName: 'Document IDs',
				name: 'documentIds',
				type: 'string',
				default: '',
				description: 'Search only these documents, separated by commas',
			},
			{
				displayName: 'Folders',
				name: 'folders',
				type: 'string',
				default: '',
				placeholder: 'e.g. contracts/2024, invoices/*',
				description:
					'Search only in these folders, separated by commas. A folder includes its subfolders. Matching is case-sensitive, and * matches any characters, including "/".',
			},
			{
				displayName: 'Minimum Score',
				name: 'minScore',
				type: 'number',
				typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
				default: 0,
				description: 'Leave out results with a lower relevance score',
			},
			{
				displayName: 'Semantic Weight',
				name: 'semanticWeight',
				type: 'number',
				typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
				default: 0.7,
				description:
					'How much meaning counts against exact keywords: 1 searches by meaning only, 0 by keywords only',
			},
		],
	},

	// Single document
	{
		...documentLocator,
		displayOptions: showFor([
			'delete',
			'get',
			'getChunks',
			'getText',
			'reprocess',
			'updateMetadata',
		]),
	},

	// Get Many
	...paginationProperties('document', 'getAll'),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: showFor(['getAll']),
		options: [
			{
				displayName: 'File Types',
				name: 'fileTypes',
				type: 'multiOptions',
				options: FILE_TYPES.map((type) => ({ name: fileTypeName(type), value: type })),
				default: [],
			},
			{
				displayName: 'Folder',
				name: 'folder',
				type: 'string',
				default: '',
				placeholder: 'e.g. contracts/2024',
				description: 'Only documents in this folder or its subfolders',
			},
			{
				displayName: 'Name Contains',
				name: 'name',
				type: 'string',
				default: '',
				description: 'Text the file path contains, ignoring case',
			},
			{
				displayName: 'Space Name or ID',
				name: 'spaceId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getSpaces' },
				default: '',
				description:
					'Only documents of this space. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
		],
	},

	// Get Text
	{
		displayName: 'Output',
		name: 'textOutput',
		type: 'options',
		options: [
			{
				name: 'Joined Text',
				value: 'joined',
				description: 'One item with the whole text',
			},
			{
				name: 'One Item per Page or Section',
				value: 'units',
				description: 'One item per page, slide, sheet or section, with its metadata',
			},
		],
		default: 'joined',
		displayOptions: showFor(['getText']),
	},

	// Update Metadata
	{
		displayName: 'Metadata',
		name: 'metadata',
		type: 'json',
		required: true,
		default: '{}',
		placeholder: '{ "project": "Q3", "obsolete": null }',
		displayOptions: showFor(['updateMetadata']),
		description:
			"Fields to add or change. Other fields stay as they are; a field set to null is removed. Localmind's own fields (such as original_filename) cannot be changed or removed.",
	},
	simplifyProperty('document', ['get', 'getAll', 'updateMetadata']),
];
