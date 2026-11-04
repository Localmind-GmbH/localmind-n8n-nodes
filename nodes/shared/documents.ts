import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import { idParam } from './params';
import { getRun } from './runs';
import { Deadline } from './polling';
import { localmindApiRequest, type Page } from './transport';

/** A document of a space's data pool, as `/v1/data` returns it. */
export interface LocalmindDocument {
	id: string;
	space_id: string;
	file_path?: string;
	file_type?: string;
	file_size?: number;
	doc_metadata?: IDataObject | null;
	processing_state?: IDataObject | null;
	/** Set when Localmind removed the stored file, for example after turning a table into SQL. */
	source_file_deleted?: boolean;
}

const POLL_MS = 3_000;
/** Localmind's scheduled recovery re-queues cancelled and retryable failed documents. */
const AUTO_RETRY =
	'Localmind tries again on its own after about 30 minutes, unless the failure is permanent or automatic recovery is turned off for the organization.';
/** How often the upload's run is checked for a cancel, which the document's state does not show. */
const RUN_CHECK_MS = 30_000;

/** "completed", "failed", "stored_only", or undefined while the document is still being processed. */
export function pipelineStatus(document: LocalmindDocument): string | undefined {
	const status = document.processing_state?.pipeline_status;
	return typeof status === 'string' ? status : undefined;
}

/** The file-manager path a document was stored under ("spaces/{space}/data/{path}"); stale after a rename. */
export function storedPath(document: LocalmindDocument): string | undefined {
	const prefix = `spaces/${document.space_id}/data/`;
	return document.file_path?.startsWith(prefix)
		? document.file_path.slice(prefix.length)
		: undefined;
}

/** The documents under a file-manager path: normally one, rarely more (a file moved onto a table's path). */
export async function documentsAtPath(
	this: IExecuteFunctions,
	spaceId: string,
	userPath: string,
	itemIndex: number,
	limit = 1,
): Promise<LocalmindDocument[]> {
	const page = (await localmindApiRequest.call(this, {
		method: 'POST',
		path: '/data/search',
		qs: { page: 1, limit },
		body: { filters: { space_id: idParam(spaceId), user_path: userPath } },
		idempotent: true,
		itemIndex,
	})) as Page<LocalmindDocument>;
	return page.items;
}

/** The document a file-manager path belongs to, if Localmind has created one. */
export async function findDocumentByPath(
	this: IExecuteFunctions,
	spaceId: string,
	userPath: string,
	itemIndex: number,
): Promise<LocalmindDocument | undefined> {
	return (await documentsAtPath.call(this, spaceId, userPath, itemIndex))[0];
}

/**
 * Whether the upload's processing run was cancelled; undefined when that cannot be told, for
 * example because the key cannot read the run (it carries no space, so a space-scoped key gets
 * "not found"). The check only shortens a wait, so no error of its own fails the upload.
 */
async function runCancelled(
	this: IExecuteFunctions,
	runId: string,
	itemIndex: number,
): Promise<boolean | undefined> {
	try {
		const run = await getRun.call(this, runId, itemIndex);
		return run.status === 'CANCELLED';
	} catch {
		return undefined;
	}
}

/** Marks an error as "processing failed", so callers can tell it from a network error. */
function processingFailed(error: NodeApiError): NodeApiError {
	error.context.processingFailed = true;
	return error;
}

/**
 * Waits until the uploaded file at `userPath` is processed (parsed, chunked, embedded) and
 * returns its document.
 *
 * Reads the document's processing state rather than the upload's run: the run carries no space,
 * so a space-scoped key cannot read it, and the upload answer has no document ID to read instead.
 * A cancel resets that state to "nothing done yet" without a final status, which looks like
 * processing that has not started; so the run (`runId`) is checked now and then where the key can
 * read it. With a key limited to spaces, a cancelled upload waits until the timeout.
 */
export async function waitForDocument(
	this: IExecuteFunctions,
	spaceId: string,
	userPath: string,
	deadline: Deadline,
	itemIndex: number,
	runId?: string,
	known?: LocalmindDocument,
): Promise<LocalmindDocument> {
	let checkRun = !!runId;
	let nextRunCheck = Date.now() + RUN_CHECK_MS;
	// A document the caller just looked up saves the first request.
	let firstLookup = known;
	for (;;) {
		const document =
			firstLookup ?? (await findDocumentByPath.call(this, spaceId, userPath, itemIndex));
		firstLookup = undefined;
		const status = document && pipelineStatus(document);
		if (document && (status === 'completed' || status === 'stored_only')) return document;
		if (document && status === 'failed') {
			const state = document.processing_state ?? {};
			const detail =
				typeof state.error === 'string' && state.error ? state.error : 'Processing failed';
			throw processingFailed(
				new NodeApiError(
					this.getNode(),
					{ message: detail },
					{
						message: `Localmind: ${detail}`,
						description: `"${userPath}" was uploaded, but processing failed${
							typeof state.failed_stage === 'string' ? ` at the ${state.failed_stage} stage` : ''
						}. Document ${document.id}. ${AUTO_RETRY}`,
						itemIndex,
					},
				),
			);
		}

		if (runId && checkRun && Date.now() >= nextRunCheck) {
			nextRunCheck = Date.now() + RUN_CHECK_MS;
			const cancelled = await runCancelled.call(this, runId, itemIndex);
			if (cancelled === undefined) checkRun = false;
			if (cancelled) {
				throw processingFailed(
					new NodeApiError(
						this.getNode(),
						{ message: 'Processing was cancelled' },
						{
							message: 'Localmind: Processing was cancelled',
							description: `"${userPath}" was uploaded, but its processing was cancelled in Localmind. ${AUTO_RETRY}${
								document
									? ` To start it at once, use Document → Reprocess (document ${document.id}).`
									: ''
							}`,
							itemIndex,
						},
					),
				);
			}
		}

		if (deadline.expired) {
			throw new NodeOperationError(
				this.getNode(),
				`"${userPath}" was uploaded but not processed within ${deadline.duration}`,
				{
					itemIndex,
					description: document
						? `Processing continues in Localmind. Check it later with Document → Get (document ${document.id}).`
						: 'Processing continues in Localmind.',
				},
			);
		}
		await deadline.wait(POLL_MS, this);
	}
}
