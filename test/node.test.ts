import { NodeApiError } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

import { Localmind } from '../nodes/Localmind/Localmind.node';
import { routedContext } from './helpers';

vi.mock('n8n-workflow', async (importOriginal) => ({
	...(await importOriginal<typeof import('n8n-workflow')>()),
	sleep: vi.fn(async () => {}),
}));

const failingJob = () =>
	routedContext(() => ({ statusCode: 404, body: { detail: 'Run not found' } }), {
		resource: 'job',
		operation: 'get',
		runId: 'run-1',
	});

describe('Localmind node', () => {
	it('marks a failed item with its index', async () => {
		const { context } = failingJob();
		Object.assign(context, { getInputData: () => [{ json: {} }, { json: {} }] });

		const execution = new Localmind().execute.call(context);

		await expect(execution).rejects.toBeInstanceOf(NodeApiError);
		await expect(execution).rejects.toMatchObject({ context: { itemIndex: 0 } });
	});

	it('keeps message and description of a failed item with Continue On Fail', async () => {
		const { context } = routedContext(() => undefined, {
			resource: 'job',
			operation: 'get',
			runId: '',
		});
		Object.assign(context, { continueOnFail: () => true });

		const [items] = await new Localmind().execute.call(context);

		expect(items).toEqual([
			{
				json: {
					error: 'The run ID is empty',
					description: 'Uploads of files Localmind only stores, and archives, have no run.',
				},
				pairedItem: { item: 0 },
			},
		]);
	});

	it('gives a failed item only an error field with "Continue (using error output)"', async () => {
		// n8n routes an item to the error output when its JSON holds nothing but `error`.
		const { context } = routedContext(() => undefined, {
			resource: 'job',
			operation: 'get',
			runId: '',
		});
		Object.assign(context, {
			continueOnFail: () => true,
			getNode: () => ({ name: 'Localmind', onError: 'continueErrorOutput' }),
		});

		const [items] = await new Localmind().execute.call(context);

		expect(items).toEqual([
			{
				json: {
					error:
						'The run ID is empty. Uploads of files Localmind only stores, and archives, have no run.',
				},
				pairedItem: { item: 0 },
			},
		]);
	});
});
