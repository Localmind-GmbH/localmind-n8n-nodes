import type { IDataObject } from 'n8n-workflow';

import { localmindApiRequest, type LocalmindContext } from './transport';

/** A processing run as `GET /v1/pipeline/{id}` returns it. */
export interface PipelineRun {
	status?: string;
	stages?: Array<{ last_error?: string | null }>;
	/** For a conversation turn: `sandbox_queued` says the turn waits to be resumed by a later run. */
	result_data?: { sandbox_queued?: boolean; assistant_message_id?: string } | null;
}

const FINISHED = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

/** Whether the run has ended. Anything else, including a status Localmind adds later, counts as still going. */
export const isRunFinished = (run: PipelineRun) => FINISHED.has(String(run.status));

export const isRunFailed = (run: PipelineRun) =>
	run.status === 'FAILED' || run.status === 'CANCELLED';

/** The first error any stage of the run reports. */
export function runError(run: PipelineRun): string | undefined {
	if (!Array.isArray(run.stages)) return undefined;
	return run.stages
		.map((stage) => (typeof stage === 'object' && stage !== null ? stage.last_error : undefined))
		.find((error): error is string => typeof error === 'string' && error !== '');
}

/** Reads a processing run (a message turn, an upload's or a reprocessing run). */
export async function getRun(
	this: LocalmindContext,
	runId: string,
	itemIndex?: number,
): Promise<PipelineRun & IDataObject> {
	return (await localmindApiRequest.call(this, {
		method: 'GET',
		path: `/pipeline/${encodeURIComponent(runId)}`,
		itemIndex,
	})) as PipelineRun & IDataObject;
}
