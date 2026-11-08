import type { INodeProperties } from 'n8n-workflow';

import { spaceLocator } from '../../../shared/spaces';

const showFor = (operation: string[]) => ({ show: { resource: ['file'], operation } });

const folderDropdown = (operation: string[], description: string): INodeProperties => ({
	displayName: 'Folder Name or ID',
	name: 'folder',
	type: 'options',
	typeOptions: { loadOptionsMethod: 'getFolders', loadOptionsDependsOn: ['space.value'] },
	default: '',
	displayOptions: showFor(operation),
	description: `${description} Folders are paths such as "contracts/2024". Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.`,
});

const pathField = (displayName: string, name: string, operation: string[], description: string) =>
	({
		displayName,
		name,
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. contracts/2024/offer.pdf',
		displayOptions: showFor(operation),
		description,
	}) as INodeProperties;

export const fileProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['file'] } },
		options: [
			{
				name: 'Delete',
				value: 'delete',
				description: 'Delete a file with its document and search index',
				action: 'Delete a file',
			},
			{
				name: 'Download',
				value: 'download',
				description: "Download a file from a space's file manager",
				action: 'Download a file',
			},
			{
				name: 'Download by URL',
				value: 'downloadByUrl',
				description: 'Download any Localmind download link, for example a file an agent generated',
				action: 'Download a file by URL',
			},
			{
				name: 'List',
				value: 'list',
				description: 'List the files and folders in a folder',
				action: 'List files',
			},
			{
				name: 'Move or Rename',
				value: 'move',
				description: 'Move or rename a file or folder',
				action: 'Move or rename a file',
			},
			{
				name: 'Upload',
				value: 'upload',
				description: "Upload a file into a space's file manager, where Localmind indexes it",
				action: 'Upload a file',
			},
		],
		default: 'upload',
	},
	{
		...spaceLocator,
		displayOptions: showFor(['delete', 'download', 'list', 'move', 'upload']),
	},

	// Upload
	{
		displayName: 'Input Binary Field',
		name: 'binaryPropertyName',
		type: 'string',
		required: true,
		default: 'data',
		displayOptions: showFor(['upload']),
		description: 'The name of the input binary field with the file to upload',
	},
	folderDropdown(['upload'], 'The folder to upload into.'),
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: showFor(['upload']),
		options: [
			{
				displayName: 'File Name',
				name: 'fileName',
				type: 'string',
				default: '',
				description:
					'The name to store the file under. Defaults to the name of the input file. When the name is taken, Localmind adds a number.',
			},
			{
				displayName: 'Timeout (Minutes)',
				name: 'timeoutMinutes',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 1440 },
				default: 10,
				description: 'How long to wait for processing',
			},
			{
				displayName: 'Wait for Processing',
				name: 'waitForProcessing',
				type: 'boolean',
				default: true,
				description:
					'Whether to wait until Localmind has indexed the file, so it can be searched right away, and return its document ID',
			},
		],
	},

	// List
	folderDropdown(['list'], 'The folder to list.'),
	{
		displayName: 'Include Subfolders',
		name: 'includeSubfolders',
		type: 'boolean',
		default: false,
		displayOptions: showFor(['list']),
		description: 'Whether to list the contents of subfolders too',
	},

	// Download, Delete, Move
	pathField('File Path', 'path', ['download'], 'The path of the file in the file manager'),
	pathField(
		'File Path',
		'path',
		['delete'],
		'The path of the file in the file manager. Folders cannot be deleted through the API.',
	),
	pathField(
		'From Path',
		'path',
		['move'],
		'The current path of the file or folder, e.g. "contracts/offer.pdf"',
	),
	pathField(
		'To Path',
		'newPath',
		['move'],
		'The full new path including the name, e.g. "archive/2024/offer.pdf", not only the target folder. The target folder must exist: an API key cannot create folders, so upload a file into it first.',
	),
	{
		displayName: 'Download URL',
		name: 'url',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. /v1/storage/download/org-…/sandbox_outputs/…/report.xlsx',
		displayOptions: showFor(['downloadByUrl']),
		description:
			'A Localmind download link, as returned for files agents generate. The file is fetched from the API URL of the credential.',
	},
	{
		displayName: 'Put Output File in Field',
		name: 'binaryPropertyName',
		type: 'string',
		required: true,
		default: 'data',
		displayOptions: showFor(['download', 'downloadByUrl']),
		description: 'The name of the output binary field to put the file in',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: showFor(['download', 'downloadByUrl']),
		options: [
			{
				displayName: 'Max File Size (MB)',
				name: 'maxFileSizeMb',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 50,
				description:
					'A larger file is not downloaded, and the node stops with an error. The download stops at this size, so a larger file never fills the memory of n8n.',
			},
		],
	},
];
