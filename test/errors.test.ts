import { describe, expect, it } from 'vitest';

import {
	agentErrorFromAnswer,
	errorDetail,
	isSandboxBusy,
	stepLimitFromAnswer,
} from '../nodes/shared/errors';

describe('errorDetail', () => {
	it('reads a FastAPI detail', () => {
		expect(errorDetail({ detail: 'Agent not found' })).toBe('Agent not found');
	});

	it('appends code or error_code', () => {
		expect(errorDetail({ detail: 'Credits exhausted', error_code: 'CREDITS_EXHAUSTED' })).toBe(
			'Credits exhausted (CREDITS_EXHAUSTED)',
		);
		expect(errorDetail({ detail: 'Provider Overloaded', code: 'provider_overloaded' })).toBe(
			'Provider Overloaded (provider_overloaded)',
		);
	});

	it('joins validation errors with their location', () => {
		expect(
			errorDetail({
				detail: [
					{ loc: ['body', 'title'], msg: 'Field required', type: 'missing' },
					{ loc: ['query', 'limit'], msg: 'Input should be less than or equal to 200' },
				],
			}),
		).toBe('body.title: Field required; query.limit: Input should be less than or equal to 200');
	});

	it('reads the OpenAI-compatible error envelope', () => {
		expect(
			errorDetail({
				error: {
					message: "Model 'x' not found",
					type: 'invalid_request_error',
					code: 'model_not_found',
				},
			}),
		).toBe("Model 'x' not found (model_not_found)");
	});

	it('ignores HTML pages and empty bodies', () => {
		expect(errorDetail('<html><body>429 Too Many Requests</body></html>')).toBeUndefined();
		expect(errorDetail('')).toBeUndefined();
		expect(errorDetail(undefined)).toBeUndefined();
		expect(errorDetail({})).toBeUndefined();
	});

	it('passes short plain text through', () => {
		expect(errorDetail('Bad Gateway')).toBe('Bad Gateway');
	});
});

describe('agentErrorFromAnswer', () => {
	it('recognises in-band error answers', () => {
		expect(agentErrorFromAnswer('[Error: Request timed out]')).toBe('Request timed out');
		expect(agentErrorFromAnswer('  [Error: An internal error occurred]\n')).toBe(
			'An internal error occurred',
		);
	});

	it('leaves normal answers alone', () => {
		expect(agentErrorFromAnswer('The report is attached.')).toBeUndefined();
		expect(agentErrorFromAnswer('I saw [Error: x] in the log and fixed it.')).toBeUndefined();
		expect(agentErrorFromAnswer('[Error: none found] Matching rows: [a, b]')).toBeUndefined();
	});
});

describe('stepLimitFromAnswer', () => {
	const notice =
		'The assistant paused after reaching the maximum number of steps (25) for a single run. Send another message (e.g. "continue") to resume the task.';

	it('reads the limit from the notice alone and after a partial answer', () => {
		expect(stepLimitFromAnswer(notice)).toBe(25);
		expect(stepLimitFromAnswer(`Here is what I found so far.\n\n${notice}`)).toBe(25);
	});

	it('ignores answers that only quote the notice', () => {
		expect(stepLimitFromAnswer(`${notice}\n\nThat is what the log said.`)).toBeUndefined();
		expect(stepLimitFromAnswer('Done.')).toBeUndefined();
	});
});

describe('isSandboxBusy', () => {
	it('reads the notice code, not the text', () => {
		expect(isSandboxBusy({ code: 'sandbox_busy', message: 'All compute resources …' })).toBe(true);
		expect(isSandboxBusy({ code: 'other' })).toBe(false);
		expect(isSandboxBusy(null)).toBe(false);
		expect(isSandboxBusy(undefined)).toBe(false);
		expect(isSandboxBusy('sandbox_busy')).toBe(false);
	});
});
