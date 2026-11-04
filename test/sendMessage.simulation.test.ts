import { sleep } from 'n8n-workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeConversation } from '../nodes/Localmind/resources/conversation/execute';
import { waitForAnswer } from '../nodes/Localmind/resources/conversation/sendMessage';
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
	return await waitForAnswer.call(context, turn, FIFTEEN_MINUTES, 0);
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
