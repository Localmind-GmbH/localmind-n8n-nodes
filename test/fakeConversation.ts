import type { ConversationMessage } from '../nodes/Localmind/resources/conversation/messages';

export const API = 'https://acme-api.example.com/v1';

export const idle = { active_run_id: null, run_status: null, sandbox_queue: null };
export const running = { active_run_id: 'r1', run_status: 'RUNNING', sandbox_queue: null };
export const inSandboxQueue = (position: number | null) => ({
	active_run_id: null,
	run_status: null,
	sandbox_queue: { message_id: 'a1', position },
});

type Run =
	| string
	| {
			status: string;
			stages?: Array<{ last_error?: string }>;
			result_data?: { sandbox_queued?: boolean };
	  };

interface Script {
	/** The light state polls, in order; the last one repeats. */
	polls: object[];
	/** The latest messages the full state read returns. */
	messages?: ConversationMessage[];
	/** The full history; defaults to `messages`. */
	history?: ConversationMessage[];
	/** Run records by ID; a list answers successive reads. */
	runs?: Record<string, Run | Run[]>;
	/** False for Localmind up to 1.5.0, whose state endpoint rejects API keys. */
	stateOpenToKeys?: boolean;
	/** Successive reads of the full history; the last one repeats. Defaults to `history`. */
	histories?: ConversationMessage[][];
	/** Successive full state reads; the last one repeats. Defaults to `messages`. */
	messageReads?: ConversationMessage[][];
}

/** A Localmind conversation API scripted for one turn of conversation c1. */
export function scriptedConversation({
	polls,
	messages = [],
	history,
	runs = { r1: 'COMPLETED' },
	stateOpenToKeys = true,
	histories,
	messageReads,
}: Script) {
	const pending = [...polls];
	const stateReads = messageReads ? [...messageReads] : undefined;
	const historyReads = histories ? [...histories] : undefined;
	const runReads: Record<string, Run[]> = Object.fromEntries(
		Object.entries(runs).map(([id, run]) => [id, Array.isArray(run) ? [...run] : [run]]),
	);
	return (options: { method: string; url: string; qs?: Record<string, unknown> }) => {
		if (options.url === `${API}/conversations/c1/state`) {
			if (!stateOpenToKeys) {
				return {
					statusCode: 401,
					body: { detail: 'API key not accepted on this endpoint. Use a Keycloak access token.' },
				};
			}
			if (options.qs?.include_messages) {
				if (stateReads) {
					return { body: { messages: stateReads.length > 1 ? stateReads.shift() : stateReads[0] } };
				}
				return { body: { messages } };
			}
			return { body: pending.length > 1 ? pending.shift() : pending[0] };
		}
		if (options.url === `${API}/conversations/c1/messages`) {
			if (historyReads) {
				return {
					body: { messages: historyReads.length > 1 ? historyReads.shift() : historyReads[0] },
				};
			}
			return { body: { messages: history ?? messages } };
		}
		const runId = /\/pipeline\/([^/]+)$/.exec(options.url)?.[1];
		if (runId && runReads[runId]) {
			const reads = runReads[runId];
			const run = reads.length > 1 ? reads.shift()! : reads[0];
			return { body: typeof run === 'string' ? { status: run } : run };
		}
		return undefined;
	};
}

export const answer = (overrides: Partial<ConversationMessage> = {}): ConversationMessage => ({
	id: 'a1',
	role: 'assistant',
	content: 'Report attached.',
	parent_message_id: 'u1',
	prompt_tokens: 12,
	completion_tokens: 8,
	total_tokens: 20,
	...overrides,
});
