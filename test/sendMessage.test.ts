import { sleep } from 'n8n-workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { waitForAnswer } from '../nodes/Localmind/resources/conversation/sendMessage';
import {
	API,
	answer,
	idle,
	inSandboxQueue,
	running,
	scriptedConversation,
} from './fakeConversation';
import { routedContext } from './helpers';

vi.mock('n8n-workflow', async (importOriginal) => ({
	...(await importOriginal<typeof import('n8n-workflow')>()),
	sleep: vi.fn(async (ms: number) => {
		vi.setSystemTime(Date.now() + ms);
	}),
}));

const turn = { run_id: 'r1', user_message_id: 'u1', conversation_id: 'c1' };
const FIFTEEN_MINUTES = 15 * 60_000;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.mocked(sleep).mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

const sleeps = () => vi.mocked(sleep).mock.calls.map(([ms]) => ms);

describe('waitForAnswer', () => {
	it('polls every 2 seconds while the agent works and returns the answer', async () => {
		const { context } = routedContext(
			scriptedConversation({ polls: [running, running, idle], messages: [answer()] }),
		);

		const result = await waitForAnswer.call(context, turn, FIFTEEN_MINUTES, 0);

		expect(result.id).toBe('a1');
		expect(sleeps()).toEqual([2_000, 2_000]);
	});

	it('waits through the code-execution queue slowly and checks the resumed run', async () => {
		const resumed = {
			active_run_id: 'r2',
			run_status: 'RUNNING',
			active_run_resumes_message_id: 'a1',
			sandbox_queue: null,
		};
		const { context, requests } = routedContext(
			scriptedConversation({
				polls: [inSandboxQueue(3), resumed, idle],
				messages: [answer()],
				runs: { r1: 'COMPLETED', r2: 'COMPLETED' },
			}),
		);

		await waitForAnswer.call(context, turn, FIFTEEN_MINUTES, 0);

		expect(sleeps()).toEqual([20_000, 2_000]);
		expect(requests.map((r) => r.url)).toContain(`${API}/pipeline/r2`);
		expect(requests.map((r) => r.url)).not.toContain(`${API}/pipeline/r1`);
	});

	it('fails when the resumed run failed, even though a message exists', async () => {
		const resumed = {
			active_run_id: 'r2',
			active_run_resumes_message_id: 'a1',
			sandbox_queue: null,
		};
		const { context } = routedContext(
			scriptedConversation({
				polls: [inSandboxQueue(1), resumed, idle],
				messages: [answer({ content: 'Let me run the analysis…' })],
				runs: { r2: { status: 'FAILED', stages: [{ last_error: 'Credits exhausted' }] } },
			}),
		);

		await expect(waitForAnswer.call(context, turn, FIFTEEN_MINUTES, 0)).rejects.toMatchObject({
			message: 'Localmind: Credits exhausted',
			description: expect.stringContaining('incomplete'),
		});
	});

	it('keeps waiting while the run has not shown up in the state yet', async () => {
		const { context, requests } = routedContext(
			scriptedConversation({
				polls: [idle, running, idle],
				messages: [answer()],
				runs: { r1: ['PENDING', 'COMPLETED'] },
			}),
		);

		const result = await waitForAnswer.call(context, turn, FIFTEEN_MINUTES, 0);

		expect(result.id).toBe('a1');
		expect(requests.filter((r) => r.qs?.include_messages === true)).toHaveLength(1);
	});

	it('reads the full history when the answer is older than the latest 50 messages', async () => {
		const { context } = routedContext(
			scriptedConversation({ polls: [idle], messages: [], history: [answer()] }),
		);

		expect((await waitForAnswer.call(context, turn, FIFTEEN_MINUTES, 0)).id).toBe('a1');
	});

	it('fails when the turn ended without an answer', async () => {
		const { context } = routedContext(scriptedConversation({ polls: [idle], messages: [] }));

		await expect(waitForAnswer.call(context, turn, FIFTEEN_MINUTES, 0)).rejects.toMatchObject({
			message: 'Localmind: The turn ended without an answer',
		});
	});

	it('times out with what the agent is doing and how to pick up the answer', async () => {
		const { context } = routedContext(
			scriptedConversation({ polls: [inSandboxQueue(4)], messages: [answer()] }),
		);

		await expect(waitForAnswer.call(context, turn, 60_000, 0)).rejects.toMatchObject({
			message:
				'No answer within 1 minute(s): the agent is still waiting for a free code-execution slot (position 4 in the queue)',
			description: expect.stringContaining('conversation c1, message u1'),
		});
		expect(sleeps()).toEqual([20_000, 20_000, 20_000]);
	});

	it('times out while the agent is working', async () => {
		const { context } = routedContext(scriptedConversation({ polls: [running] }));

		await expect(waitForAnswer.call(context, turn, 60_000, 0)).rejects.toMatchObject({
			message: 'No answer within 1 minute(s): the agent is still working',
		});
	});
});

describe('waitForAnswer on Localmind up to 1.5.0, without the state endpoint', () => {
	const parked = answer({
		content: 'Running the analysis…',
		metadata: {
			run_id: 'r1',
			widgets: [{ type: 'info', info_type: 'sandbox_queued', position: 2 }],
		},
	});
	const parkedRun = { status: 'COMPLETED', result_data: { sandbox_queued: true } };

	it('returns the answer once the run is done when the turn did not wait for a sandbox', async () => {
		const { context } = routedContext(
			scriptedConversation({
				polls: [],
				stateOpenToKeys: false,
				runs: { r1: ['RUNNING', { status: 'COMPLETED', result_data: { sandbox_queued: false } }] },
				histories: [[answer()]],
			}),
		);

		const result = await waitForAnswer.call(context, turn, FIFTEEN_MINUTES, 0);

		expect(result.content).toBe('Report attached.');
		expect(sleeps()).toEqual([2_000]);
	});

	it('waits for the run that resumes a parked turn, not for the card to disappear', async () => {
		// The resumed run's first save drops the card but keeps the parked run's ID; only its final
		// save writes its own.
		const resuming = answer({ content: 'Let me run the analysis…', metadata: { run_id: 'r1' } });
		const { context, requests } = routedContext(
			scriptedConversation({
				polls: [],
				stateOpenToKeys: false,
				runs: { r1: parkedRun, r2: ['RUNNING', 'COMPLETED'] },
				histories: [[parked], [resuming], [answer({ metadata: { run_id: 'r2' } })]],
			}),
		);

		const result = await waitForAnswer.call(context, turn, FIFTEEN_MINUTES, 0);

		expect(result.content).toBe('Report attached.');
		expect(requests.map((r) => r.url)).toContain(`${API}/pipeline/r2`);
		// The queue, the slower polls while the turn resumes, then the resumed run.
		expect(sleeps()).toEqual([20_000, 10_000, 2_000]);
	});

	it('times out while waiting for a sandbox, with the place in line', async () => {
		const { context } = routedContext(
			scriptedConversation({
				polls: [],
				stateOpenToKeys: false,
				runs: { r1: parkedRun },
				histories: [[parked]],
			}),
		);

		await expect(waitForAnswer.call(context, turn, 60_000, 0)).rejects.toMatchObject({
			message:
				'No answer within 1 minute(s): the agent is still waiting for a free code-execution slot (position 2 in the queue)',
		});
	});

	it('returns a turn whose wait ended without a slot, for the caller to report', async () => {
		const busy = answer({
			metadata: { run_id: 'r1', widgets: [{ type: 'info', info_type: 'sandbox_busy' }] },
		});
		const { context } = routedContext(
			scriptedConversation({
				polls: [],
				stateOpenToKeys: false,
				runs: { r1: parkedRun },
				histories: [[parked], [busy]],
			}),
		);

		const result = await waitForAnswer.call(context, turn, FIFTEEN_MINUTES, 0);

		expect(result.metadata?.widgets).toEqual([{ type: 'info', info_type: 'sandbox_busy' }]);
	});

	it('fails when the run failed without an answer', async () => {
		const { context } = routedContext(
			scriptedConversation({
				polls: [],
				stateOpenToKeys: false,
				runs: { r1: { status: 'FAILED', stages: [{ last_error: 'Credits exhausted' }] } },
				histories: [[]],
			}),
		);

		await expect(waitForAnswer.call(context, turn, FIFTEEN_MINUTES, 0)).rejects.toMatchObject({
			message: 'Localmind: Credits exhausted',
			description: 'The agent stopped before it answered.',
		});
	});

	it("returns a failed turn's error message instead of the run's raw error", async () => {
		// Localmind saves a failed turn's error as an empty message with the text in its metadata.
		const failed = answer({
			content: '',
			metadata: {
				error: true,
				error_message: 'The conversation is too long',
				code: 'context_overflow',
			},
		});
		const { context } = routedContext(
			scriptedConversation({
				polls: [],
				stateOpenToKeys: false,
				runs: {
					r1: { status: 'FAILED', stages: [{ last_error: 'ContextWindowExceededError: …' }] },
				},
				histories: [[failed]],
			}),
		);

		const result = await waitForAnswer.call(context, turn, FIFTEEN_MINUTES, 0);

		expect(result.metadata?.code).toBe('context_overflow');
	});

	it('fails when the turn ended without an answer', async () => {
		const { context } = routedContext(
			scriptedConversation({ polls: [], stateOpenToKeys: false, histories: [[]] }),
		);

		await expect(waitForAnswer.call(context, turn, FIFTEEN_MINUTES, 0)).rejects.toMatchObject({
			message: 'Localmind: The turn ended without an answer',
		});
	});
});

describe('waitForAnswer when a resumed turn does not finish', () => {
	const card = (resolved: boolean) => ({
		widgets: [
			{ type: 'info', info_type: 'sandbox_queued', position: 1, ...(resolved && { resolved }) },
		],
	});

	const parked = { status: 'COMPLETED', result_data: { sandbox_queued: true } };

	it('keeps waiting on Localmind up to 1.5.0 while the resuming run has not saved yet', async () => {
		// Localmind retires the card just before the resuming run first saves the answer.
		const { context, requests } = routedContext(
			scriptedConversation({
				polls: [],
				stateOpenToKeys: false,
				runs: { r1: parked, r2: 'COMPLETED' },
				histories: [
					[answer({ metadata: { run_id: 'r1', ...card(false) } })],
					[answer({ metadata: { run_id: 'r1', ...card(true) } })],
					[answer({ content: 'Report attached.', metadata: { run_id: 'r2' } })],
				],
			}),
		);

		const result = await waitForAnswer.call(context, turn, FIFTEEN_MINUTES, 0);

		expect(result.metadata?.run_id).toBe('r2');
		expect(requests.map((r) => r.url)).toContain(`${API}/pipeline/r2`);
	});

	it('fails when the resuming run ended without its final save and nothing runs anymore', async () => {
		const partial = answer({ content: 'Let me build the report…', metadata: { run_id: 'r1' } });
		const { context } = routedContext(
			scriptedConversation({
				polls: [inSandboxQueue(1), idle],
				messageReads: [[answer({ metadata: { run_id: 'r1', ...card(false) } })], [partial]],
				runs: { r1: parked },
			}),
		);

		await expect(waitForAnswer.call(context, turn, FIFTEEN_MINUTES, 0)).rejects.toMatchObject({
			message: 'Localmind: The run that resumed the turn ended without saving its answer',
		});
		expect(sleeps().reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(2 * 60_000);
	});

	it('reports the failed resumed run, not the leftover sandbox card', async () => {
		const resumed = {
			active_run_id: 'r2',
			active_run_resumes_message_id: 'a1',
			sandbox_queue: null,
		};
		const { context } = routedContext(
			scriptedConversation({
				polls: [inSandboxQueue(1), resumed, idle],
				messages: [answer({ metadata: card(true) })],
				runs: { r2: { status: 'FAILED', stages: [{ last_error: 'Credit limit exceeded' }] } },
			}),
		);

		await expect(waitForAnswer.call(context, turn, FIFTEEN_MINUTES, 0)).rejects.toMatchObject({
			message: 'Localmind: Credit limit exceeded',
		});
	});
});

describe('waitForAnswer for a turn stopped in the app', () => {
	it('returns the answer marked as stopped, for the caller to report it clearly', async () => {
		const { context } = routedContext(
			scriptedConversation({
				polls: [idle],
				messages: [answer({ metadata: { cancelled: true } })],
				runs: { r1: 'CANCELLED' },
			}),
		);

		const result = await waitForAnswer.call(context, turn, FIFTEEN_MINUTES, 0);

		expect(result.metadata?.cancelled).toBe(true);
	});

	it('says the turn was stopped when the run was cancelled before an answer', async () => {
		const { context } = routedContext(
			scriptedConversation({ polls: [idle], messages: [], runs: { r1: 'CANCELLED' } }),
		);

		await expect(waitForAnswer.call(context, turn, FIFTEEN_MINUTES, 0)).rejects.toMatchObject({
			message: 'Localmind: The turn was stopped',
		});
	});
});

describe('waitForAnswer with another turn in the same conversation', () => {
	it('follows the run that resumes the turn when a newer turn hides it in the state', async () => {
		// The state shows only the newest open run: here the other turn's r9, not our r2.
		const otherRun = {
			active_run_id: 'r9',
			run_status: 'RUNNING',
			active_run_resumes_message_id: null,
			sandbox_queue: null,
		};
		const queuedCard = {
			widgets: [{ type: 'info', info_type: 'sandbox_queued', position: 1 }],
		};
		const retiredCard = {
			widgets: [{ type: 'info', info_type: 'sandbox_queued', position: 1, resolved: true }],
		};
		const { context, requests } = routedContext(
			scriptedConversation({
				polls: [inSandboxQueue(1), otherRun, otherRun, otherRun],
				messageReads: [
					[answer({ metadata: { run_id: 'r1', ...queuedCard } })],
					[answer({ metadata: { run_id: 'r1', ...retiredCard } })],
					[answer({ content: 'Report attached.', metadata: { run_id: 'r2' } })],
				],
				runs: {
					r1: { status: 'COMPLETED', result_data: { sandbox_queued: true } },
					r2: ['RUNNING', 'COMPLETED'],
				},
			}),
		);

		const result = await waitForAnswer.call(context, turn, FIFTEEN_MINUTES, 0);

		expect(result).toMatchObject({ content: 'Report attached.', metadata: { run_id: 'r2' } });
		expect(requests.filter((r) => r.url === `${API}/pipeline/r2`)).toHaveLength(2);
	});

	it("does not wait for another turn's sandbox wait", async () => {
		const otherTurnParked = {
			active_run_id: null,
			run_status: null,
			sandbox_queue: { message_id: 'x1', position: 1 },
		};
		const { context } = routedContext(
			scriptedConversation({
				polls: [otherTurnParked],
				messages: [answer(), answer({ id: 'x1', parent_message_id: 'other' })],
			}),
		);

		const result = await waitForAnswer.call(context, turn, FIFTEEN_MINUTES, 0);

		expect(result.id).toBe('a1');
	});
});
