import type { ConversationMessage } from '../nodes/Localmind/resources/conversation/messages';
import { API } from './fakeConversation';

/**
 * One turn of conversation c1 as Localmind runs it over time, replaying how the backend saves the
 * answer: the turn's run r1 ends; a parked turn waits in the code-execution queue with an open
 * card; when it gets a slot, the resuming run r2 is created and the card is retired; r2 first saves
 * the answer (dropping the card, keeping r1's ID) only after a tool step, and writes its own ID
 * in its final save. Times are milliseconds after the message was sent.
 */
export interface Scenario {
	/** False for Localmind up to 1.5.0, whose state endpoint rejects API keys. */
	stateEndpoint: boolean;
	/** When the turn's run r1 ends. */
	firstRunEndsAt: number;
	/** The turn waits for a code-execution slot until this time. */
	parkedUntil?: number;
	/** The run r2 that resumes a parked turn, created when the wait ends. */
	resume?: {
		/** When r2 first saves the answer (after its first tool step); never if unset. */
		firstSaveAt?: number;
		endsAt: number;
		outcome: 'COMPLETED' | 'FAILED';
	};
	/** Another turn's run r9 in the same conversation, newer than r2. */
	otherTurn?: { from: number; to: number };
}

const card = (resolved: boolean) => ({
	type: 'info',
	info_type: 'sandbox_queued',
	position: 1,
	...(resolved && { resolved: true }),
});

export const FINAL = 'Report attached.';

export function simulatedLocalmind(scenario: Scenario) {
	const sentAt = Date.now();
	const { firstRunEndsAt, parkedUntil, resume, otherTurn } = scenario;

	const answer = (t: number): ConversationMessage | undefined => {
		const base = { id: 'a1', role: 'assistant', parent_message_id: 'u1' };
		if (t < firstRunEndsAt) return undefined;
		if (parkedUntil === undefined) {
			return { ...base, content: FINAL, metadata: { run_id: 'r1' } };
		}
		if (t < parkedUntil) {
			return {
				...base,
				content: 'Let me run the analysis…',
				metadata: { run_id: 'r1', widgets: [card(false)] },
			};
		}
		if (resume && t >= resume.endsAt && resume.outcome === 'COMPLETED') {
			return { ...base, content: FINAL, metadata: { run_id: 'r2', widgets: [] } };
		}
		if (resume?.firstSaveAt !== undefined && t >= resume.firstSaveAt) {
			return { ...base, content: 'Running the analysis…', metadata: { run_id: 'r1', widgets: [] } };
		}
		return {
			...base,
			content: 'Let me run the analysis…',
			metadata: { run_id: 'r1', widgets: [card(true)] },
		};
	};

	const messages = (t: number): ConversationMessage[] => {
		const found = answer(t);
		const user = { id: 'u1', role: 'user', content: 'Build the report', parent_message_id: null };
		const list: ConversationMessage[] = found ? [user, found] : [user];
		// From 1.6.0 a failed run leaves an empty error message after the partial answer.
		if (scenario.stateEndpoint && resume?.outcome === 'FAILED' && t >= resume.endsAt) {
			list.push({
				id: 'e1',
				role: 'assistant',
				content: '',
				parent_message_id: 'u1',
				metadata: {
					error: true,
					error_message: 'Sandbox crashed',
					code: 'agent_error',
					run_id: 'r2',
				},
			});
		}
		if (otherTurn && t >= otherTurn.from) {
			list.push({ id: 'u2', role: 'user', content: 'Something else', parent_message_id: null });
			if (t >= otherTurn.to) {
				list.push({
					id: 'x1',
					role: 'assistant',
					content: 'Other answer',
					parent_message_id: 'u2',
					metadata: { run_id: 'r9' },
				});
			}
		}
		return list;
	};

	const run = (id: string, t: number) => {
		if (id === 'r1') {
			if (t < firstRunEndsAt) return { status: 'RUNNING' };
			return { status: 'COMPLETED', result_data: { sandbox_queued: parkedUntil !== undefined } };
		}
		if (id === 'r9' && otherTurn) {
			return t < otherTurn.to
				? { status: 'RUNNING' }
				: { status: 'COMPLETED', result_data: { sandbox_queued: false } };
		}
		if (id === 'r2' && resume && parkedUntil !== undefined && t >= parkedUntil) {
			if (t < parkedUntil + 1_000) return { status: 'PENDING' };
			if (t < resume.endsAt) return { status: 'RUNNING' };
			return resume.outcome === 'FAILED'
				? { status: 'FAILED', stages: [{ last_error: 'Sandbox crashed' }] }
				: { status: 'COMPLETED', result_data: { sandbox_queued: false } };
		}
		return undefined;
	};

	const state = (t: number) => {
		const open: Array<{ id: string; createdAt: number }> = [];
		if (t < firstRunEndsAt) open.push({ id: 'r1', createdAt: 0 });
		if (resume && parkedUntil !== undefined && t >= parkedUntil && t < resume.endsAt) {
			open.push({ id: 'r2', createdAt: parkedUntil });
		}
		if (otherTurn && t >= otherTurn.from && t < otherTurn.to) {
			open.push({ id: 'r9', createdAt: otherTurn.from });
		}
		// The state shows only the newest open run.
		const active = open.sort((a, b) => b.createdAt - a.createdAt)[0];
		const parked = parkedUntil !== undefined && t >= firstRunEndsAt && t < parkedUntil;
		return {
			active_run_id: active?.id ?? null,
			// The backend maps PENDING to QUEUED; a resuming run starts about a second after creation.
			run_status: active
				? active.id === 'r2' && t < (parkedUntil ?? 0) + 1_000
					? 'QUEUED'
					: 'RUNNING'
				: null,
			active_run_resumes_message_id: active?.id === 'r2' ? 'a1' : null,
			sandbox_queue: parked ? { message_id: 'a1', position: 1 } : null,
		};
	};

	return (options: { url: string; qs?: Record<string, unknown> }) => {
		const t = Date.now() - sentAt;
		if (options.url === `${API}/conversations/c1/state`) {
			if (!scenario.stateEndpoint) {
				return { statusCode: 401, body: { detail: 'API key not accepted on this endpoint.' } };
			}
			return { body: options.qs?.include_messages ? { messages: messages(t) } : state(t) };
		}
		if (options.url === `${API}/conversations/c1/messages`)
			return { body: { messages: messages(t) } };
		const runId = /\/pipeline\/([^/]+)$/.exec(options.url)?.[1];
		if (runId) {
			const found = run(runId, t);
			return found ? { body: found } : { statusCode: 404, body: { detail: 'Run not found' } };
		}
		return undefined;
	};
}
