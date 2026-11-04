import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { textParam } from '../../../shared/params';
import { Deadline, timeoutMs } from '../../../shared/polling';
import { getRun, isRunFinished, runError } from '../../../shared/runs';
import { simplifyRun } from '../simplify';

interface JobOptions {
	timeoutMinutes?: unknown;
	waitUntilFinished?: boolean;
}

const POLL_MS = 3_000;

export async function executeJob(
	this: IExecuteFunctions,
	operation: string,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	if (operation !== 'get') {
		throw new NodeOperationError(this.getNode(), `Unknown job operation "${operation}"`, {
			itemIndex,
		});
	}

	const runId = textParam(this.getNodeParameter('runId', itemIndex)).trim();
	if (!runId) {
		throw new NodeOperationError(this.getNode(), 'The run ID is empty', {
			itemIndex,
			description: 'Uploads of files Localmind only stores, and archives, have no run.',
		});
	}
	const options = this.getNodeParameter('options', itemIndex, {}) as JobOptions;
	// The timeout only matters when waiting; an unused one must not fail the read.
	const deadline = options.waitUntilFinished
		? new Deadline(timeoutMs(this.getNode(), options.timeoutMinutes, itemIndex))
		: undefined;

	for (;;) {
		const run = await getRun.call(this, runId, itemIndex);
		const finished = isRunFinished(run);
		if (!deadline || finished) {
			if (this.getNodeParameter('simplify', itemIndex, true) as boolean) {
				return [{ json: simplifyRun(run) }];
			}
			// Not "error": n8n 2.16 counts any item with an "error" key as failed (Retry On Fail).
			const runFailure = runError(run);
			return [{ json: { ...run, finished, ...(runFailure && { errorMessage: runFailure }) } }];
		}
		if (deadline.expired) {
			throw new NodeOperationError(
				this.getNode(),
				`Run ${runId} did not finish within ${deadline.duration}; it is ${String(run.status).toLowerCase()}`,
				{ itemIndex },
			);
		}
		await deadline.wait(POLL_MS, this);
	}
}
