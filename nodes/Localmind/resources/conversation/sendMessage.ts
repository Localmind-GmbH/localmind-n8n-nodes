import type { IExecuteFunctions, JsonObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import { Deadline } from '../../../shared/polling';
import {
	getRun,
	isRunFailed,
	isRunFinished,
	runError,
	type PipelineRun,
} from '../../../shared/runs';
import { localmindApiRequest } from '../../../shared/transport';
import { answerFor, infoWidget, type ConversationMessage } from './messages';

/** The API rejects longer messages (counted in characters, as Localmind counts them). */
export const MAX_MESSAGE_LENGTH = 50_000;

const ACTIVE_POLL_MS = 2_000;
const SANDBOX_QUEUE_POLL_MS = 20_000;
/** A turn resuming after its sandbox wait can work for minutes; each poll may read the full history. */
const RESUMING_POLL_MS = 10_000;

/** The 202 answer of `POST /v1/conversations/{id}/messages-async`. */
export interface QueuedTurn {
	run_id: string;
	user_message_id: string;
	conversation_id: string;
	status?: string;
}

interface ConversationState {
	active_run_id?: string | null;
	run_status?: string | null;
	active_run_resumes_message_id?: string | null;
	sandbox_queue?: { message_id: string; position?: number | null } | null;
	messages?: ConversationMessage[];
}

/** What a turn is doing while the node waits. */
export type TurnPhase =
	| { kind: 'starting' }
	| { kind: 'working' }
	| { kind: 'sandboxQueue'; position?: number | null }
	| { kind: 'resuming' };

/** What a turn is doing, in words for an error message. */
export function describePhase(phase: TurnPhase): string {
	switch (phase.kind) {
		case 'sandboxQueue':
			return phase.position
				? `still waiting for a free code-execution slot (position ${phase.position} in the queue)`
				: 'still waiting for a free code-execution slot';
		case 'starting':
			return 'still waiting for Localmind to start the agent';
		case 'working':
			return 'still working';
		case 'resuming':
			return 'probably still working: it got a code-execution slot and continues in a new run';
	}
}

function phaseOfState(state: ConversationState): TurnPhase {
	if (state.sandbox_queue) return { kind: 'sandboxQueue', position: state.sandbox_queue.position };
	if (state.active_run_id && state.run_status === 'QUEUED') return { kind: 'starting' };
	return { kind: 'working' };
}

function pollInterval(phase: TurnPhase): number {
	if (phase.kind === 'sandboxQueue') return SANDBOX_QUEUE_POLL_MS;
	if (phase.kind === 'resuming') return RESUMING_POLL_MS;
	return ACTIVE_POLL_MS;
}

function timeoutError(
	this: IExecuteFunctions,
	turn: QueuedTurn,
	deadline: Deadline,
	phase: TurnPhase,
	itemIndex: number,
): NodeOperationError {
	return new NodeOperationError(
		this.getNode(),
		`No answer within ${deadline.duration}: the agent is ${describePhase(phase)}`,
		{
			itemIndex,
			description: `The turn may still be running in Localmind. Before sending the message again, read its answer with Conversation → Get Messages (conversation ${turn.conversation_id}, message ${turn.user_message_id}), or raise the timeout.`,
		},
	);
}

/** Sleeps until the next poll, or throws the timeout error when the time is up. */
async function waitBeforeNextPoll(
	this: IExecuteFunctions,
	turn: QueuedTurn,
	deadline: Deadline,
	phase: TurnPhase,
	itemIndex: number,
): Promise<void> {
	if (deadline.expired) throw timeoutError.call(this, turn, deadline, phase, itemIndex);
	await deadline.wait(pollInterval(phase), this);
}

async function getState(
	this: IExecuteFunctions,
	conversationId: string,
	includeMessages: boolean,
	itemIndex: number,
): Promise<ConversationState> {
	return (await localmindApiRequest.call(this, {
		method: 'GET',
		path: `/conversations/${encodeURIComponent(conversationId)}/state`,
		qs: { include_messages: includeMessages },
		itemIndex,
	})) as ConversationState;
}

/**
 * The light conversation state, or undefined on a Localmind that does not let API keys read it
 * (Localmind up to 1.5.0). The message was just sent with the same key, so a 401 here means the
 * endpoint, not the key.
 */
async function getStateIfOpenToKeys(
	this: IExecuteFunctions,
	conversationId: string,
	itemIndex: number,
): Promise<ConversationState | undefined> {
	try {
		return await getState.call(this, conversationId, false, itemIndex);
	} catch (error) {
		if (error instanceof NodeApiError && error.httpCode === '401') return undefined;
		throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex });
	}
}

/** How many of the latest answers Get Messages checks for a resume still in progress. */
const RESUME_CHECK_LIMIT = 3;

/**
 * The answers a run is still working on after their turn's wait for a code-execution slot, which
 * the messages themselves do not show: they keep the parked run's ID and a retired card (or no
 * card) until the resuming run's final save. Checks the latest few answers, since a message sent
 * meanwhile adds a newer one.
 *
 * On a Localmind with the state endpoint, the active run names the message it resumes; while
 * another turn's run is active, that one can hide it, and the message's own run is checked as on
 * Localmind up to 1.5.0: the message counts as resuming while its run ID still names the run that
 * parked it. A resume that failed there looks the same.
 */
export async function resumingMessages(
	this: IExecuteFunctions,
	conversationId: string,
	messages: ConversationMessage[],
	itemIndex: number,
): Promise<Set<string>> {
	const resuming = new Set<string>();
	const candidates = messages
		.filter((message) => message.role === 'assistant' && message.id)
		.slice(-RESUME_CHECK_LIMIT);
	if (!candidates.length) return resuming;
	const state = await getStateIfOpenToKeys.call(this, conversationId, itemIndex);
	if (state && !state.active_run_id) return resuming;
	for (const message of candidates) {
		const id = message.id as string;
		if (state?.active_run_resumes_message_id === id) resuming.add(id);
		else if (await parkedRunUnfinished.call(this, message, itemIndex)) resuming.add(id);
	}
	return resuming;
}

/** Whether the message's run ID still names the run that parked its turn. */
async function parkedRunUnfinished(
	this: IExecuteFunctions,
	message: ConversationMessage,
	itemIndex: number,
): Promise<boolean> {
	const runId = message.metadata?.run_id;
	if (typeof runId !== 'string' || !runId || infoWidget(message, 'sandbox_busy')) return false;
	const card = infoWidget(message, 'sandbox_queued');
	if (card && card.resolved !== true) return false;
	try {
		return (await getRun.call(this, runId, itemIndex)).result_data?.sandbox_queued === true;
	} catch (error) {
		// A key limited to spaces cannot read every run.
		if (error instanceof NodeApiError && ['403', '404'].includes(String(error.httpCode))) {
			return false;
		}
		throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex });
	}
}

async function getHistory(
	this: IExecuteFunctions,
	conversationId: string,
	itemIndex: number,
): Promise<ConversationMessage[]> {
	const history = (await localmindApiRequest.call(this, {
		method: 'GET',
		path: `/conversations/${encodeURIComponent(conversationId)}/messages`,
		itemIndex,
	})) as { messages?: ConversationMessage[] };
	return history.messages ?? [];
}

/** Reads the answer once: the latest 50 messages first, the full history if it is older. */
async function findAnswer(
	this: IExecuteFunctions,
	turn: QueuedTurn,
	itemIndex: number,
): Promise<ConversationMessage | undefined> {
	const state = await getState.call(this, turn.conversation_id, true, itemIndex);
	return (
		answerFor(state.messages ?? [], turn.user_message_id) ??
		answerFor(await getHistory.call(this, turn.conversation_id, itemIndex), turn.user_message_id)
	);
}

function noAnswer(this: IExecuteFunctions, itemIndex: number): NodeApiError {
	return new NodeApiError(
		this.getNode(),
		{ message: 'The turn ended without an answer' },
		{
			message: 'Localmind: The turn ended without an answer',
			description:
				'Localmind saved no answer for this message. Check the conversation in the Localmind app, then send the message again if needed.',
			itemIndex,
		},
	);
}

/**
 * The answer of a turn whose last run has finished. Localmind's own error message is returned as
 * it is (the caller reports its text and code); otherwise a failed run becomes an error with the
 * run's error, which names the cause better than a leftover card on the message.
 */
function settle(
	this: IExecuteFunctions,
	run: PipelineRun,
	answer: ConversationMessage | undefined,
	itemIndex: number,
): ConversationMessage {
	// The caller reports Localmind's own error message and a turn stopped in the app as they are.
	if (answer?.metadata?.error === true || answer?.metadata?.cancelled === true) return answer;
	if (run.status === 'CANCELLED' && !runError(run)) {
		throw new NodeApiError(
			this.getNode(),
			{ message: 'The turn was stopped' },
			{
				message: 'Localmind: The turn was stopped',
				description: answer
					? 'It was stopped in the Localmind app or by an administrator; the answer in the conversation is incomplete.'
					: 'It was stopped in the Localmind app or by an administrator before the agent answered.',
				itemIndex,
			},
		);
	}
	if (isRunFailed(run)) {
		const detail = runError(run) ?? `the run ended ${String(run.status).toLowerCase()}`;
		throw new NodeApiError(
			this.getNode(),
			{ message: detail },
			{
				message: `Localmind: ${detail}`,
				description: answer
					? 'The agent stopped before it finished; the answer in the conversation is incomplete.'
					: 'The agent stopped before it answered.',
				itemIndex,
			},
		);
	}
	if (!answer) throw noAnswer.call(this, itemIndex);
	return answer;
}

/** Waits until a run has finished and returns its record. */
async function waitForRun(
	this: IExecuteFunctions,
	turn: QueuedTurn,
	runId: string,
	deadline: Deadline,
	itemIndex: number,
): Promise<PipelineRun> {
	for (;;) {
		const run = await getRun.call(this, runId, itemIndex);
		if (isRunFinished(run)) return run;
		const phase: TurnPhase = run.status === 'PENDING' ? { kind: 'starting' } : { kind: 'working' };
		await waitBeforeNextPoll.call(this, turn, deadline, phase, itemIndex);
	}
}

/**
 * How long the node keeps waiting for a turn that looks like it is resuming while the conversation
 * shows nothing running. Localmind retires the turn's waiting card when the resuming run starts,
 * and that run first saves the answer (dropping the card) only after a tool step; until its final
 * save the answer keeps the parked run's ID. A turn that can never be resumed looks the same, so
 * the node gives up only where the state endpoint shows that no run is working on the
 * conversation. On Localmind up to 1.5.0 it cannot see that and waits until the timeout.
 */
const RESUME_GRACE_MS = 2 * 60_000;

type TurnProgress =
	| { kind: 'done' }
	| { kind: 'resumedBy'; runId: string }
	| { kind: 'queued'; position?: number | null }
	| { kind: 'handingOver' }
	| { kind: 'resuming' };

/**
 * Reads the answer after the run the node followed has finished. A run that parked the turn in
 * the code-execution queue (its result says `sandbox_queued`) hands the turn to a later run, which
 * writes its own ID into the answer's metadata; until then the answer still carries the parked
 * run's ID.
 */
function progressOf(
	run: PipelineRun,
	checkedRuns: Set<string>,
	answer: ConversationMessage | undefined,
): TurnProgress {
	if (!answer) return { kind: 'done' };
	const runId = answer.metadata?.run_id;
	if (typeof runId === 'string' && runId && !checkedRuns.has(runId)) {
		return { kind: 'resumedBy', runId };
	}
	if (run.result_data?.sandbox_queued !== true) return { kind: 'done' };
	// A wait that ended without a slot finishes the turn with a "sandbox_busy" card.
	if (infoWidget(answer, 'sandbox_busy')) return { kind: 'done' };
	const card = infoWidget(answer, 'sandbox_queued');
	if (!card) return { kind: 'resuming' };
	if (card.resolved !== true) {
		return { kind: 'queued', position: card.position as number | null | undefined };
	}
	return { kind: 'handingOver' };
}

/** Tracks how long a turn has looked like it is resuming while nothing runs in the conversation. */
class HandOver {
	private since: number | undefined;

	/**
	 * Whether to stop waiting; resets when the turn looks different or a run is active.
	 * `idle`: the conversation state shows no run (never known without the state endpoint).
	 */
	givenUp(progress: TurnProgress, idle: boolean): boolean {
		const resuming = progress.kind === 'handingOver' || progress.kind === 'resuming';
		if (!resuming || !idle) {
			this.since = undefined;
			return false;
		}
		this.since ??= Date.now();
		return Date.now() - this.since >= RESUME_GRACE_MS;
	}
}

function phaseOfProgress(progress: TurnProgress): TurnPhase {
	if (progress.kind === 'queued') return { kind: 'sandboxQueue', position: progress.position };
	return { kind: 'resuming' };
}

function resumeLost(this: IExecuteFunctions, itemIndex: number): NodeApiError {
	return new NodeApiError(
		this.getNode(),
		{ message: 'The run that resumed the turn ended without saving its answer' },
		{
			message: 'Localmind: The run that resumed the turn ended without saving its answer',
			description:
				'The agent stopped after it got a code-execution slot; the answer in the conversation is incomplete. Check the conversation in Localmind before sending the message again.',
			itemIndex,
		},
	);
}

/**
 * Waits on a Localmind that cannot show the conversation state to an API key (up to 1.5.0).
 *
 * Follows the turn's run, then the runs that resume it (see `progressOf`), reading the answer from
 * the history. The "streaming" flag cannot be used here: these versions never set it on a message
 * that was saved before the wait.
 */
async function waitWithoutState(
	this: IExecuteFunctions,
	turn: QueuedTurn,
	deadline: Deadline,
	itemIndex: number,
): Promise<ConversationMessage> {
	const checkedRuns = new Set([turn.run_id]);
	let run = await waitForRun.call(this, turn, turn.run_id, deadline, itemIndex);
	for (;;) {
		const history = await getHistory.call(this, turn.conversation_id, itemIndex);
		const answer = answerFor(history, turn.user_message_id);
		const progress = progressOf(run, checkedRuns, answer);
		// These versions cannot show whether a run still works on the turn: wait until the timeout.
		if (progress.kind === 'done') return settle.call(this, run, answer, itemIndex);
		if (progress.kind === 'resumedBy') {
			checkedRuns.add(progress.runId);
			run = await waitForRun.call(this, turn, progress.runId, deadline, itemIndex);
			continue;
		}
		await waitBeforeNextPoll.call(this, turn, deadline, phaseOfProgress(progress), itemIndex);
	}
}

/**
 * Waits until a queued turn has finished and returns its answer.
 *
 * Follows the API's documented contract ("Waiting for a Turn"): poll the conversation state, not
 * the run, because a turn that waits for a code-execution slot completes its run at once and
 * continues later in a new run. The turn is finished when neither a run nor a sandbox wait of its
 * own is active and the answer points to no newer run. The state shows only the newest open run,
 * so a run that resumes the turn can hide behind another turn's run; the answer's run ID still
 * names it. On a Localmind whose state endpoint does not accept API keys yet, it follows run and
 * history instead.
 */
export async function waitForAnswer(
	this: IExecuteFunctions,
	turn: QueuedTurn,
	timeoutMs: number,
	itemIndex: number,
): Promise<ConversationMessage> {
	const deadline = new Deadline(timeoutMs);
	let runId = turn.run_id;
	const checkedRuns = new Set([runId]);
	const handOver = new HandOver();

	// The state covers the whole conversation; another turn can be parked or running in it.
	const ownership = new Map<string, boolean>();
	const isOurs = async (messageId: string): Promise<boolean> => {
		if (!ownership.has(messageId)) {
			const { messages = [] } = await getState.call(this, turn.conversation_id, true, itemIndex);
			const message = messages.find((candidate) => candidate.id === messageId);
			ownership.set(messageId, message?.parent_message_id === turn.user_message_id);
		}
		return ownership.get(messageId) === true;
	};

	let state = await getStateIfOpenToKeys.call(this, turn.conversation_id, itemIndex);
	if (!state) return await waitWithoutState.call(this, turn, deadline, itemIndex);

	for (;;) {
		const parked =
			state.sandbox_queue && (await isOurs(state.sandbox_queue.message_id))
				? state.sandbox_queue
				: undefined;
		if (
			state.active_run_id &&
			state.active_run_resumes_message_id &&
			(await isOurs(state.active_run_resumes_message_id))
		) {
			runId = state.active_run_id;
			checkedRuns.add(runId);
		}
		const ourRunActive = !!state.active_run_id && checkedRuns.has(state.active_run_id);

		let phase: TurnPhase = parked
			? { kind: 'sandboxQueue', position: parked.position }
			: phaseOfState({ ...state, sandbox_queue: null });
		if (!parked && !ourRunActive) {
			const run = await getRun.call(this, runId, itemIndex);
			// A run that has not finished has not shown up in the state yet: keep waiting.
			if (isRunFinished(run)) {
				const answer = await findAnswer.call(this, turn, itemIndex);
				const progress = progressOf(run, checkedRuns, answer);
				if (progress.kind === 'done') return settle.call(this, run, answer, itemIndex);
				if (handOver.givenUp(progress, !state.active_run_id)) {
					if (progress.kind === 'resuming') throw resumeLost.call(this, itemIndex);
					return settle.call(this, run, answer, itemIndex);
				}
				if (progress.kind === 'resumedBy') {
					runId = progress.runId;
					checkedRuns.add(runId);
					continue;
				}
				phase = phaseOfProgress(progress);
			}
		}

		await waitBeforeNextPoll.call(this, turn, deadline, phase, itemIndex);
		state = await getState.call(this, turn.conversation_id, false, itemIndex);
	}
}
