import type { INodeProperties } from 'n8n-workflow';
import { simplifyProperty } from '../simplify';

const showFor = (operation: string[]) => ({ show: { resource: ['job'], operation } });

export const jobProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['job'] } },
		options: [
			{
				name: 'Get',
				value: 'get',
				description: 'Get the status of a processing run, for example a reprocessed document',
				action: 'Get a job',
			},
		],
		default: 'get',
	},
	{
		displayName: 'Run ID',
		name: 'runId',
		type: 'string',
		required: true,
		default: '',
		displayOptions: showFor(['get']),
		description:
			'The ID of the run, as Reprocess or Upload return it. A key limited to spaces cannot read these runs ("not found"); wait with File → Upload\'s Wait for Processing or read the document\'s status with Document → Get instead. For a message, use Conversation → Send Message: its run can end while the turn still waits for a code sandbox.',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: showFor(['get']),
		options: [
			{
				displayName: 'Timeout (Minutes)',
				name: 'timeoutMinutes',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 1440 },
				default: 15,
				description: 'How long to wait for the run to end',
			},
			{
				displayName: 'Wait Until Finished',
				name: 'waitUntilFinished',
				type: 'boolean',
				default: false,
				description: 'Whether to wait until the run has completed, failed or been cancelled',
			},
		],
	},
	simplifyProperty('job', ['get']),
];
