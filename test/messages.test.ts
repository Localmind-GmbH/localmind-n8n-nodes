import { describe, expect, it } from 'vitest';

import {
	answerFor,
	generatedFiles,
	messageStatus,
	simplifyMessage,
	supersededMessages,
	turnFailure,
	type ConversationMessage,
} from '../nodes/Localmind/resources/conversation/messages';

const assistant = (overrides: Partial<ConversationMessage>): ConversationMessage => ({
	role: 'assistant',
	content: 'Done.',
	parent_message_id: 'u1',
	...overrides,
});

describe('answerFor', () => {
	it('takes the last assistant message answering the sent message', () => {
		const messages = [
			{ id: 'u1', role: 'user', content: 'Hi' },
			assistant({ id: 'a1', content: 'partial' }),
			assistant({ id: 'x', parent_message_id: 'other-turn' }),
			assistant({ id: 'a2', content: 'error' }),
		];
		expect(answerFor(messages, 'u1')?.id).toBe('a2');
	});

	it('returns undefined when the turn has no answer', () => {
		expect(answerFor([{ id: 'u1', role: 'user', content: 'Hi' }], 'u1')).toBeUndefined();
	});
});

describe('generatedFiles', () => {
	it('reads file_download widgets, encodes the link and drops the generic MIME type', () => {
		const message = assistant({
			metadata: {
				widgets: [
					{ type: 'markdown', content: 'Here you go' },
					{
						type: 'file_download',
						files: [
							{
								filename: 'Q3 report.xlsx',
								url: '/v1/storage/download/org-1/sandbox_outputs/1/c1/Q3 report.xlsx',
								size: 2048,
								content_type: 'application/octet-stream',
							},
						],
					},
					{
						type: 'file_download',
						files: [
							{
								filename: 'Q3 report.xlsx',
								url: '/v1/storage/download/org-1/sandbox_outputs/1/c1/Q3 report.xlsx',
							},
							{
								filename: 'chart.png',
								url: '/v1/storage/download/org-1/c.png',
								content_type: 'image/png',
							},
						],
					},
				],
			},
		});

		expect(generatedFiles(message)).toEqual([
			{
				fileName: 'Q3 report.xlsx',
				url: '/v1/storage/download/org-1/sandbox_outputs/1/c1/Q3 report.xlsx',
				path: '/storage/download/org-1/sandbox_outputs/1/c1/Q3%20report.xlsx',
				size: undefined,
				mimeType: undefined,
			},
			{
				fileName: 'chart.png',
				url: '/v1/storage/download/org-1/c.png',
				path: '/storage/download/org-1/c.png',
				size: undefined,
				mimeType: 'image/png',
			},
		]);
	});

	it('returns no files for a message without widgets', () => {
		expect(generatedFiles(assistant({}))).toEqual([]);
	});

	it('keeps a link Localmind encoded already (1.7.0) instead of encoding it twice', () => {
		const message = assistant({
			metadata: {
				widgets: [
					{
						type: 'file_download',
						files: [
							{
								filename: 'Bericht Q3 (für Max).xlsx',
								url: '/v1/storage/download/org-1/sandbox_outputs/1/c1/Bericht%20Q3%20%28f%C3%BCr%20Max%29.xlsx',
							},
						],
					},
				],
			},
		});

		expect(generatedFiles(message)[0].path).toBe(
			'/storage/download/org-1/sandbox_outputs/1/c1/Bericht%20Q3%20%28f%C3%BCr%20Max%29.xlsx',
		);
	});

	it('lists a file once when one link is raw and another encoded', () => {
		const message = assistant({
			metadata: {
				widgets: [
					{
						type: 'file_download',
						files: [
							{
								filename: 'a b.pdf',
								url: '/v1/storage/download/org-1/sandbox_outputs/1/c1/a b.pdf',
							},
							{
								filename: 'a b.pdf',
								url: '/v1/storage/download/org-1/sandbox_outputs/1/c1/a%20b.pdf',
							},
						],
					},
				],
			},
		});

		expect(generatedFiles(message).map((file) => file.path)).toEqual([
			'/storage/download/org-1/sandbox_outputs/1/c1/a%20b.pdf',
		]);
	});
});

describe('turnFailure', () => {
	it('reports the error marker with its code', () => {
		expect(
			turnFailure(
				assistant({
					content: '',
					metadata: {
						error: true,
						error_message: 'The conversation is too long',
						code: 'context_overflow',
					},
				}),
			),
		).toEqual({ message: 'The conversation is too long', code: 'context_overflow' });
	});

	it('does not count an approval step that was already decided', () => {
		expect(
			turnFailure(assistant({ metadata: { widgets: [{ type: 'approval', status: 'approved' }] } })),
		).toBeUndefined();
	});

	it('reports a turn stopped at the step limit, with how to go on', () => {
		const failure = turnFailure(
			assistant({
				metadata: {
					widgets: [{ type: 'info', info_type: 'recursion_limit', recursion_limit: 25 }],
				},
			}),
		);
		expect(failure).toMatchObject({
			message: 'The agent stopped after reaching its maximum number of steps (25)',
			description: expect.stringContaining('continue'),
		});
	});

	it('reports a turn stopped in the app', () => {
		expect(turnFailure(assistant({ metadata: { cancelled: true } }))?.message).toBe(
			'The turn was stopped in the Localmind app',
		);
	});

	it('reports an approval step', () => {
		expect(turnFailure(assistant({ metadata: { widgets: [{ type: 'approval' }] } }))?.message).toBe(
			'The agent paused at an approval step',
		);
	});

	it('reports a turn that found no code-execution slot', () => {
		const failure = turnFailure(
			assistant({
				metadata: {
					widgets: [{ type: 'info', info_type: 'sandbox_busy', retry_after_seconds: 90 }],
				},
			}),
		);
		expect(failure?.message).toContain('No code-execution slot');
		expect(failure?.description).toContain('about 2 minute(s)');
	});

	it('reports a turn that waited and was never resumed', () => {
		expect(
			turnFailure(
				assistant({ metadata: { widgets: [{ type: 'info', info_type: 'sandbox_queued' }] } }),
			)?.message,
		).toContain('did not finish');
	});

	it('accepts a normal answer', () => {
		expect(
			turnFailure(assistant({ metadata: { widgets: [{ type: 'markdown' }] } })),
		).toBeUndefined();
	});
});

describe('simplifyMessage', () => {
	it('lists generated files with a safe name and type, and the link as sent', () => {
		const url = '/v1/storage/download/org-1/sandbox_outputs/1/c1/x.exe';
		const message = assistant({
			metadata: {
				widgets: [
					{
						type: 'file_download',
						files: [
							{
								filename: '../../report\u202Efdp.exe',
								url,
								content_type: 'text/html\r\nX-Injected: 1',
							},
						],
					},
				],
			},
		});

		expect(simplifyMessage(message).files).toEqual([
			{ fileName: 'reportfdp.exe', size: undefined, mimeType: undefined, url },
		]);
	});

	it('keeps text, files, tokens and the failure of an assistant message', () => {
		expect(
			simplifyMessage(
				assistant({
					id: 'a1',
					prompt_tokens: 10,
					completion_tokens: 5,
					total_tokens: 15,
					metadata: { error: true, error_message: 'Boom' },
				}),
			),
		).toEqual({
			id: 'a1',
			role: 'assistant',
			text: 'Done.',
			timestamp: undefined,
			parentMessageId: 'u1',
			status: 'failed',
			files: [],
			tokens: { prompt: 10, completion: 5, total: 15 },
			errorMessage: 'Boom',
		});
	});
});

describe('messageStatus', () => {
	const queued = { widgets: [{ type: 'info', info_type: 'sandbox_queued' }] };

	it('tells answers in progress, waiting, failed and complete apart', () => {
		expect(messageStatus(assistant({ is_streaming: true }))).toBe('in progress');
		expect(messageStatus(assistant({ metadata: queued }))).toBe('waiting for a code sandbox');
		expect(messageStatus(assistant({ metadata: { error: true } }))).toBe('failed');
		expect(messageStatus(assistant({}))).toBe('complete');
	});

	it('does not label a turn that waits for a sandbox as failed', () => {
		expect(simplifyMessage(assistant({ metadata: queued })).error).toBeUndefined();
	});
});

describe('supersededMessages', () => {
	it('marks a partial answer that an error message of the same turn follows', () => {
		const messages = [
			assistant({ id: 'a1', content: 'Let me look that up…' }),
			assistant({ id: 'a2', metadata: { error: true } }),
			assistant({ id: 'b1', parent_message_id: 'u2' }),
		];
		expect([...supersededMessages(messages)]).toEqual(['a1']);
		expect(simplifyMessage(messages[0], true).status).toBe('incomplete');
	});
});
