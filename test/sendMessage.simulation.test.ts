import { sleep } from 'n8n-workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeConversation } from '../nodes/Localmind/resources/conversation/execute';
import { waitForAnswer } from '../nodes/Localmind/resources/conversation/sendMessage';
import { Deadline } from '../nodes/shared/polling';
import { API } from './fakeConversation';
import { routedContext } from './helpers';
import { FINAL, simulatedLocalmind, type Scenario } from './simulatedLocalmind';

vi.mock('n8n-workflow', async (importOriginal) => ({
	...(await importOriginal<typeof import('n8n-workflow')>()),
	sleep: vi.fn(async (ms: number) => {
		vi.setSystemTime(Date.now() + ms);
	}),
}));

const turn = { run_id: 'r1', user_message_id: 'u1', conversation_id: 'c1' };
const FIFTEEN_MINUTES = 15 * 60_000;
const MINUTE = 60_000;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.mocked(sleep).mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

const elapsed = () => vi.mocked(sleep).mock.calls.reduce((sum, [ms]) => sum + ms, 0);

async function wait(scenario: Scenario) {
	const { context } = routedContext(simulatedLocalmind(scenario));
	return await waitForAnswer.call(context, turn, new Deadline(FIFTEEN_MINUTES), 0);
}

const parked = { firstRunEndsAt: 5_000, parkedUntil: 3 * MINUTE };

describe.each([
	{ version: 'Localmind up to 1.5.0', stateEndpoint: false },
	{ version: 'current Localmind', stateEndpoint: true },
])('Send Message waiting on $version', ({ stateEndpoint }) => {
	it('returns the answer of a turn that needed no sandbox wait', async () => {
		const result = await wait({ stateEndpoint, firstRunEndsAt: 20_000 });

		expect(result.content).toBe(FINAL);
	});

	it('returns the final answer of a parked turn that resumes quickly', async () => {
		const result = await wait({
			stateEndpoint,
			...parked,
			resume: {
				firstSaveAt: parked.parkedUntil + 20_000,
				endsAt: parked.parkedUntil + MINUTE,
				outcome: 'COMPLETED',
			},
		});

		expect(result).toMatchObject({ content: FINAL, metadata: { run_id: 'r2' } });
	});

	it('keeps waiting while the resumed run spends 5 minutes on its first code step', async () => {
		// Until its first save, the answer shows the retired card and the parked run's ID.
		const result = await wait({
			stateEndpoint,
			...parked,
			resume: {
				firstSaveAt: parked.parkedUntil + 5 * MINUTE,
				endsAt: parked.parkedUntil + 6 * MINUTE,
				outcome: 'COMPLETED',
			},
		});

		expect(result).toMatchObject({ content: FINAL, metadata: { run_id: 'r2' } });
	});

	it('keeps waiting while the resumed run works for 8 minutes after saving partial text', async () => {
		const result = await wait({
			stateEndpoint,
			...parked,
			resume: {
				firstSaveAt: parked.parkedUntil + 30_000,
				endsAt: parked.parkedUntil + 8 * MINUTE,
				outcome: 'COMPLETED',
			},
		});

		expect(result).toMatchObject({ content: FINAL, metadata: { run_id: 'r2' } });
	});
});

describe('Send Message on Localmind up to 1.5.0 when the resumed turn never finishes', () => {
	it.each([
		{ case: 'no run resumes the turn', resume: undefined },
		{
			case: 'the resumed run fails before it saves',
			resume: { endsAt: parked.parkedUntil + 2 * MINUTE, outcome: 'FAILED' as const },
		},
		{
			case: 'the resumed run fails after saving partial text',
			resume: {
				firstSaveAt: parked.parkedUntil + 30_000,
				endsAt: parked.parkedUntil + 2 * MINUTE,
				outcome: 'FAILED' as const,
			},
		},
	])('times out when $case, and says to check the answer before resending', async ({ resume }) => {
		await expect(wait({ stateEndpoint: false, ...parked, resume })).rejects.toMatchObject({
			message: expect.stringContaining('No answer within 15 minute(s)'),
			description: expect.stringContaining('Before sending the message again'),
		});
	});
});

describe('Send Message on current Localmind when the resumed turn never finishes', () => {
	it('stops 2 minutes after the wait ended without a run, for the caller to report', async () => {
		const result = await wait({ stateEndpoint: true, ...parked });

		expect(result.metadata?.widgets).toEqual([expect.objectContaining({ resolved: true })]);
		expect(elapsed()).toBeGreaterThanOrEqual(parked.parkedUntil + 2 * MINUTE);
		expect(elapsed()).toBeLessThan(parked.parkedUntil + 4 * MINUTE);
	});

	it.each([
		{ case: 'before it saves', firstSaveAt: undefined },
		{ case: 'after saving partial text', firstSaveAt: parked.parkedUntil + 30_000 },
	])(
		'returns the error message Localmind writes for a resumed run that failed $case',
		async ({ firstSaveAt }) => {
			await expect(
				wait({
					stateEndpoint: true,
					...parked,
					resume: { firstSaveAt, endsAt: parked.parkedUntil + 2 * MINUTE, outcome: 'FAILED' },
				}),
				// Localmind's own error message, which Send Message reports with its text and code.
			).resolves.toMatchObject({ metadata: { error: true, error_message: 'Sandbox crashed' } });
		},
	);
});

describe('Send Message on current Localmind when a newer turn hides the resumed run', () => {
	it.each([
		{ case: 'saves early', firstSaveAt: parked.parkedUntil + 30_000 },
		{
			case: 'spends 5 minutes on its first code step',
			firstSaveAt: parked.parkedUntil + 5 * MINUTE,
		},
	])('follows the resumed run that $case', async ({ firstSaveAt }) => {
		const endsAt = parked.parkedUntil + 6 * MINUTE;
		const result = await wait({
			stateEndpoint: true,
			...parked,
			resume: { firstSaveAt, endsAt, outcome: 'COMPLETED' },
			otherTurn: { from: parked.parkedUntil + 1, to: endsAt + MINUTE },
		});

		expect(result).toMatchObject({ content: FINAL, metadata: { run_id: 'r2' } });
	});

	it('returns the error message Localmind writes for a hidden resumed run that failed', async () => {
		await expect(
			wait({
				stateEndpoint: true,
				...parked,
				resume: {
					firstSaveAt: parked.parkedUntil + 30_000,
					endsAt: parked.parkedUntil + 2 * MINUTE,
					outcome: 'FAILED',
				},
				otherTurn: { from: parked.parkedUntil + 1, to: parked.parkedUntil + 4 * MINUTE },
			}),
		).resolves.toMatchObject({ metadata: { error: true, error_message: 'Sandbox crashed' } });
	});
});

describe.each([
	{ version: 'Localmind up to 1.5.0', stateEndpoint: false },
	{ version: 'current Localmind', stateEndpoint: true },
])('Get Messages status of a resuming turn on $version', ({ stateEndpoint }) => {
	async function statusAt(t: number, firstSaveAt: number) {
		const route = simulatedLocalmind({
			stateEndpoint,
			...parked,
			resume: { firstSaveAt, endsAt: parked.parkedUntil + 6 * MINUTE, outcome: 'COMPLETED' },
		});
		vi.setSystemTime(Date.now() + t);
		const { context } = routedContext(route, { conversation: 'c1', simplify: true });
		const items = await executeConversation.call(context, 'getMessages', 0);
		return items.at(-1)?.json;
	}

	it('says the turn waits while it is in the code-execution queue', async () => {
		expect(await statusAt(MINUTE, parked.parkedUntil + 30_000)).toMatchObject({
			status: 'waiting for a code sandbox',
		});
	});

	it('says in progress, not failed, while the resumed run works on its first code step', async () => {
		const message = await statusAt(
			parked.parkedUntil + 2 * MINUTE,
			parked.parkedUntil + 5 * MINUTE,
		);

		expect(message).toMatchObject({ status: 'in progress' });
		expect(message).not.toHaveProperty('error');
	});

	it('says in progress, not complete, while the resumed run works after saving partial text', async () => {
		expect(
			await statusAt(parked.parkedUntil + 2 * MINUTE, parked.parkedUntil + 30_000),
		).toMatchObject({ status: 'in progress', text: 'Running the analysis…' });
	});

	it('says complete once the resumed run has saved its answer', async () => {
		expect(
			await statusAt(parked.parkedUntil + 7 * MINUTE, parked.parkedUntil + 30_000),
		).toMatchObject({ status: 'complete', text: FINAL });
	});
});

describe('Get Messages status on current Localmind with another turn in the conversation', () => {
	async function messagesAt(t: number, otherTurn: { from: number; to: number }) {
		const route = simulatedLocalmind({
			stateEndpoint: true,
			...parked,
			resume: {
				firstSaveAt: parked.parkedUntil + 5 * MINUTE,
				endsAt: parked.parkedUntil + 8 * MINUTE,
				outcome: 'COMPLETED',
			},
			otherTurn,
		});
		vi.setSystemTime(Date.now() + t);
		const { context } = routedContext(route, { conversation: 'c1', simplify: true });
		const items = await executeConversation.call(context, 'getMessages', 0);
		return Object.fromEntries(items.map((item) => [item.json.id, item.json]));
	}

	it('says in progress while the other turn hides the resumed run', async () => {
		const messages = await messagesAt(parked.parkedUntil + 2 * MINUTE, {
			from: parked.parkedUntil + 1,
			to: parked.parkedUntil + 7 * MINUTE,
		});

		expect(messages.a1).toMatchObject({ status: 'in progress' });
		expect(messages.a1).not.toHaveProperty('error');
	});

	it('says in progress although a newer answer follows it', async () => {
		const messages = await messagesAt(parked.parkedUntil + 4 * MINUTE, {
			from: parked.parkedUntil + 1,
			to: parked.parkedUntil + 3 * MINUTE,
		});

		expect(messages.x1).toMatchObject({ status: 'complete' });
		expect(messages.a1).toMatchObject({ status: 'in progress' });
	});
});

describe('Send Message against a server that keeps naming new runs', () => {
	/** Every run is finished, and every read of the answer names a run the node has not seen. */
	function hostileLocalmind(stateEndpoint: boolean) {
		let reads = 0;
		let requests = 0;
		const messages = () => {
			reads++;
			return [
				{ id: 'u1', role: 'user', content: 'Build the report', parent_message_id: null },
				{
					id: 'a1',
					role: 'assistant',
					content: 'Working…',
					parent_message_id: 'u1',
					metadata: { run_id: `r${reads + 1}` },
				},
			];
		};
		const route = (options: { url: string; qs?: Record<string, unknown> }) => {
			requests++;
			if (options.url === `${API}/conversations/c1/state`) {
				if (!stateEndpoint) return { statusCode: 401, body: { detail: 'Not for API keys' } };
				return {
					body: options.qs?.include_messages
						? { messages: messages() }
						: { active_run_id: null, run_status: null, sandbox_queue: null },
				};
			}
			if (options.url === `${API}/conversations/c1/messages`) {
				return { body: { messages: messages() } };
			}
			if (/\/pipeline\/[^/]+$/.test(options.url)) {
				return { body: { status: 'COMPLETED', result_data: { sandbox_queued: false } } };
			}
			return undefined;
		};
		return { route, requests: () => requests };
	}

	it.each([
		{ version: 'Localmind up to 1.5.0', stateEndpoint: false },
		{ version: 'current Localmind', stateEndpoint: true },
	])('stops after a bounded number of requests on $version', async ({ stateEndpoint }) => {
		const hostile = hostileLocalmind(stateEndpoint);
		const { context } = routedContext(hostile.route);

		await expect(
			waitForAnswer.call(context, turn, new Deadline(FIFTEEN_MINUTES), 0),
		).rejects.toMatchObject({
			message: 'Localmind named more than 50 runs for this message',
		});
		expect(hostile.requests()).toBeLessThan(250);
	});

	it('also stops at the run limit when the time is already up', async () => {
		const hostile = hostileLocalmind(true);
		const { context } = routedContext(hostile.route);

		// The run limit, not the timeout, ends it: a run found at the deadline may hold the answer.
		await expect(waitForAnswer.call(context, turn, new Deadline(0), 0)).rejects.toMatchObject({
			message: 'Localmind named more than 50 runs for this message',
		});
		expect(hostile.requests()).toBeLessThan(250);
	});
});

describe('Send Message when the resumed turn finishes just before the timeout', () => {
	it.each([
		{ version: 'Localmind up to 1.5.0', stateEndpoint: false },
		{ version: 'current Localmind', stateEndpoint: true },
	])('returns the answer, not a timeout, on $version', async ({ stateEndpoint }) => {
		const result = await wait({
			stateEndpoint,
			...parked,
			resume: {
				firstSaveAt: parked.parkedUntil + 30_000,
				endsAt: FIFTEEN_MINUTES - 1_000,
				outcome: 'COMPLETED',
			},
		});

		expect(result).toMatchObject({ content: FINAL, metadata: { run_id: 'r2' } });
	});
});
