import { describe, expect, it, vi } from 'vitest';

import { askFiles, askRequest, parseJsonAnswer } from '../nodes/Localmind/resources/agent/ask';
import { executeAgent } from '../nodes/Localmind/resources/agent/execute';
import { API } from './fakeConversation';
import { routedContext } from './helpers';

vi.mock('n8n-workflow', async (importOriginal) => ({
	...(await importOriginal<typeof import('n8n-workflow')>()),
	sleep: vi.fn(async () => {}),
}));

const AGENT_ID = '0b6f6c1e-8d1a-4c9e-9f3b-2a7d5e4c1b90';
const fileUrl = '/v1/storage/download/org-1/sandbox_outputs/1/run/summary.docx';

describe('askRequest', () => {
	it('builds a plain prompt with overrides', () => {
		expect(
			askRequest(
				AGENT_ID,
				'Summarise',
				{ systemMessage: 'Answer in German.', temperature: 0, maxTokens: 500, jsonOutput: true },
				[],
			),
		).toEqual({
			model: AGENT_ID,
			messages: [
				{ role: 'system', content: 'Answer in German.\n\nRespond with a JSON object.' },
				{ role: 'user', content: 'Summarise' },
			],
			stream: false,
			temperature: 0,
			max_tokens: 500,
			response_format: { type: 'json_object' },
		});
	});

	it('adds no JSON instruction when a message already mentions JSON', () => {
		expect(
			askRequest(AGENT_ID, 'Return JSON with the totals', { jsonOutput: true }, []).messages,
		).toEqual([{ role: 'user', content: 'Return JSON with the totals' }]);
	});

	it('puts attachments after the prompt text', () => {
		const image = { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,x' } };
		expect(askRequest(AGENT_ID, 'What is this?', {}, [image]).messages).toEqual([
			{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, image] },
		]);
	});
});

describe('parseJsonAnswer', () => {
	it('parses plain and fenced JSON', () => {
		expect(parseJsonAnswer('{"total": 3}')).toEqual({ total: 3 });
		expect(parseJsonAnswer('```json\n{"total": 3}\n```')).toEqual({ total: 3 });
	});

	it('returns undefined for prose', () => {
		expect(parseJsonAnswer('The total is 3.')).toBeUndefined();
	});
});

describe('askFiles', () => {
	it('reads the documented attachments field', () => {
		expect(
			askFiles({
				attachments: [
					{
						filename: 'summary.docx',
						url: fileUrl,
						mime_type: 'application/msword',
						size_bytes: 10,
					},
				],
			}),
		).toEqual([
			{
				fileName: 'summary.docx',
				url: fileUrl,
				path: '/storage/download/org-1/sandbox_outputs/1/run/summary.docx',
				size: 10,
				mimeType: 'application/msword',
			},
		]);
		expect(askFiles({ attachments: null })).toEqual([]);
	});

	// Localmind names the file as stored, and the link ends in that name, raw or encoded.
	it.each([
		['raw, up to Localmind 1.6.0', 'Bericht Q3 (für Max).xlsx', 'Bericht Q3 (für Max).xlsx'],
		[
			'encoded, from Localmind 1.7.0',
			'Bericht Q3 (für Max).xlsx',
			'Bericht%20Q3%20%28f%C3%BCr%20Max%29.xlsx',
		],
		['raw, with "%20" in the name', 'Growth_5%20.xlsx', 'Growth_5%20.xlsx'],
		['encoded, with "%20" in the name', 'Growth_5%20.xlsx', 'Growth_5%2520.xlsx'],
		['raw, with a "%" that is no escape', 'Umsatz_100%Effizienz.xlsx', 'Umsatz_100%Effizienz.xlsx'],
	])('requests the file under its own name (%s)', (_, filename, linkName) => {
		const [file] = askFiles({
			attachments: [{ filename, url: `/v1/storage/download/org-1/sandbox_outputs/1/${linkName}` }],
		});
		expect(decodeURIComponent(file.path.split('/').pop() ?? '')).toBe(filename);
	});
});

describe('Agent → Ask', () => {
	const completion = (content: string, extra: object = {}) => ({
		body: {
			choices: [{ message: { content }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
			...extra,
		},
	});

	it('sends documents as file blocks and returns the answer with generated files', async () => {
		const { context, requests } = routedContext(
			(options) => {
				if (options.url === `${API}/chat/completions`) {
					return completion('Summary attached.', {
						attachments: [
							{
								filename: 'summary.docx',
								url: fileUrl,
								mime_type: 'application/octet-stream',
								size_bytes: 4,
							},
						],
					});
				}
				if (options.url === `https://acme-api.example.com${fileUrl}`)
					return { body: Buffer.from('docx') };
				return undefined;
			},
			{ agent: AGENT_ID, prompt: 'Summarise the contract', options: { attachments: 'contract' } },
			{ contract: { mimeType: 'application/pdf', fileName: 'contract.pdf', data: '%PDF' } },
		);

		const [item] = await executeAgent.call(context, 'ask', 0);

		// Ten minutes plus a margin, so Localmind's own timeout message arrives first.
		expect(requests[0]).toMatchObject({ timeout: 10 * 60_000 + 15_000 });
		expect((requests[0].body as { messages: unknown[] }).messages).toEqual([
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'Summarise the contract' },
					{
						type: 'file',
						file: {
							filename: 'contract.pdf',
							file_data: `data:application/pdf;base64,${Buffer.from('%PDF').toString('base64')}`,
						},
					},
				],
			},
		]);
		expect(item.json).toEqual({
			agentId: AGENT_ID,
			text: 'Summary attached.',
			files: [
				{
					fileName: 'summary.docx',
					size: 4,
					mimeType: undefined,
					url: fileUrl,
					binaryProperty: 'file_0',
				},
			],
			tokens: { prompt: 30, completion: 10, total: 40 },
			finishReason: 'stop',
		});
		expect(item.binary?.file_0).toMatchObject({ fileName: 'summary.docx' });
	});

	it('parses JSON output', async () => {
		const { context } = routedContext(() => completion('```json\n{"total": 3}\n```'), {
			agent: AGENT_ID,
			prompt: 'Count',
			options: { jsonOutput: true },
		});

		const [item] = await executeAgent.call(context, 'ask', 0);

		expect(item.json.output).toEqual({ total: 3 });
	});

	it('fails when JSON output is not JSON', async () => {
		const { context } = routedContext(() => completion('Three.'), {
			agent: AGENT_ID,
			prompt: 'Count',
			options: { jsonOutput: true },
		});

		await expect(executeAgent.call(context, 'ask', 0)).rejects.toMatchObject({
			message: "The agent's answer is not valid JSON",
		});
	});

	it('does not repeat the request after a 429, so an agent does not act twice', async () => {
		const { context, requests } = routedContext(
			() => ({
				statusCode: 429,
				headers: { 'retry-after': '60' },
				body: { detail: 'Rate limit exceeded', error_code: 'RATE_LIMIT_EXCEEDED' },
			}),
			{ agent: AGENT_ID, prompt: 'Send the weekly mail' },
		);

		await expect(executeAgent.call(context, 'ask', 0)).rejects.toMatchObject({
			message: 'Localmind: Rate limit exceeded (RATE_LIMIT_EXCEEDED)',
			httpCode: '429',
		});
		expect(requests).toHaveLength(1);
	});

	it('fails when the agent stopped at its step limit', async () => {
		const { context } = routedContext(
			() =>
				completion(
					'The assistant paused after reaching the maximum number of steps (25) for a single run. Send another message (e.g. "continue") to resume the task.',
				),
			{ agent: AGENT_ID, prompt: 'Hi' },
		);

		await expect(executeAgent.call(context, 'ask', 0)).rejects.toMatchObject({
			message: 'The agent stopped after reaching its maximum number of steps (25)',
		});
	});

	it('refuses an image type Localmind does not accept, before sending anything', async () => {
		const { context, requests } = routedContext(
			() => ({ body: {} }),
			{ agent: AGENT_ID, prompt: 'What is this?', options: { attachments: 'scan' } },
			{ scan: { data: 'BM', mimeType: 'image/bmp', fileName: 'scan.bmp' } },
		);

		await expect(executeAgent.call(context, 'ask', 0)).rejects.toMatchObject({
			message: '"scan.bmp" (image/bmp) cannot be sent to the agent',
		});
		expect(requests).toHaveLength(0);
	});

	it('fails on an empty answer without files', async () => {
		const { context } = routedContext(() => completion(''), { agent: AGENT_ID, prompt: 'Hi' });

		await expect(executeAgent.call(context, 'ask', 0)).rejects.toMatchObject({
			message: 'The agent returned no answer',
		});
	});

	it('fails when all code sandboxes were busy, before parsing JSON output', async () => {
		const busy =
			'Alle Rechenressourcen sind derzeit belegt – bitte versuchen Sie es später noch einmal.';
		const { context } = routedContext(
			() => completion(busy, { notice: { code: 'sandbox_busy', message: busy } }),
			{ agent: AGENT_ID, prompt: 'Compute it', options: { jsonOutput: true } },
		);

		await expect(executeAgent.call(context, 'ask', 0)).rejects.toMatchObject({
			message: 'No code-execution slot was free, so the agent could not run its code',
		});
	});

	it('turns an "[Error: …]" answer into an error', async () => {
		const { context } = routedContext(() => completion('[Error: Request timed out]'), {
			agent: AGENT_ID,
			prompt: 'Hi',
		});

		await expect(executeAgent.call(context, 'ask', 0)).rejects.toMatchObject({
			message: 'Localmind: Request timed out',
		});
	});
});
