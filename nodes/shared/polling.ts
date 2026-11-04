import type { INode } from 'n8n-workflow';
import { NodeOperationError, sleep } from 'n8n-workflow';

/** Default of the "Timeout (Minutes)" options that wait for Localmind. */
export const DEFAULT_TIMEOUT_MINUTES = 15;

/** Localmind stops an answer of its OpenAI-compatible endpoint (Ask, Chat Model) after 600 s. */
export const COMPLETION_TIMEOUT_MINUTES = 10;

/** Time for Localmind's own "timed out" answer to arrive after its 600 s are up. */
const COMPLETION_TIMEOUT_MARGIN_MS = 15_000;

/** The timeout of a request to the OpenAI-compatible endpoint; longer waits cannot help. */
export function completionTimeoutMs(node: INode, minutes: unknown, itemIndex: number): number {
	const wanted = timeoutMs(node, minutes, itemIndex, COMPLETION_TIMEOUT_MINUTES);
	const limit = COMPLETION_TIMEOUT_MINUTES * 60_000;
	return wanted >= limit ? limit + COMPLETION_TIMEOUT_MARGIN_MS : wanted;
}

/**
 * A "Timeout (Minutes)" option in milliseconds. An expression can yield anything; a value that
 * is not a positive number would make a polling loop run without pause, so it is refused.
 */
export function timeoutMs(
	node: INode,
	minutes: unknown,
	itemIndex: number,
	fallbackMinutes = DEFAULT_TIMEOUT_MINUTES,
): number {
	const value =
		minutes === undefined || minutes === null || minutes === '' ? fallbackMinutes : Number(minutes);
	if (!Number.isFinite(value) || value <= 0) {
		throw new NodeOperationError(
			node,
			`'Timeout (Minutes)' must be a positive number, not "${String(minutes)}"`,
			{
				itemIndex,
			},
		);
	}
	return value * 60_000;
}

/** A node context whose execution can be cancelled (load-options contexts cannot). */
export interface Cancellable {
	getNode(): INode;
	getExecutionCancelSignal?: () => AbortSignal | undefined;
}

/** Whether the n8n execution has been cancelled; loops that keep going after errors must stop then. */
export function isCancelled(context: Cancellable): boolean {
	return context.getExecutionCancelSignal?.()?.aborted === true;
}

/**
 * Sleeps, but stops with an error as soon as the n8n execution is cancelled: polls and retry
 * pauses can last up to two minutes, and the node would otherwise keep calling Localmind.
 */
export async function pause(context: Cancellable, ms: number): Promise<void> {
	const signal = context.getExecutionCancelSignal?.();
	if (!signal) return await sleep(ms);
	const cancelled = () => new NodeOperationError(context.getNode(), 'The execution was cancelled');
	if (signal.aborted) throw cancelled();
	let onAbort: (() => void) | undefined;
	try {
		await Promise.race([
			sleep(ms),
			new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(cancelled());
				signal.addEventListener('abort', onAbort, { once: true });
			}),
		]);
	} finally {
		if (onAbort) signal.removeEventListener('abort', onAbort);
	}
}

/** A duration in words for messages: whole minutes, or seconds below a minute ("0 minute(s)" helps nobody). */
export function durationText(ms: number): string {
	return ms < 60_000
		? `${Math.max(1, Math.round(ms / 1000))} second(s)`
		: `${Math.round(ms / 60_000)} minute(s)`;
}

/** The time a polling loop may still wait. */
export class Deadline {
	private readonly end: number;

	constructor(readonly timeoutMs: number) {
		this.end = Date.now() + timeoutMs;
	}

	get expired(): boolean {
		return Date.now() >= this.end;
	}

	/** The timeout in words, for messages: "15 minute(s)", or seconds below a minute. */
	get duration(): string {
		return durationText(this.timeoutMs);
	}

	/** Sleeps until the next poll, but not past the deadline nor past a cancel of the execution. */
	async wait(intervalMs: number, context: Cancellable): Promise<void> {
		await pause(context, Math.max(0, Math.min(intervalMs, this.end - Date.now())));
	}
}
