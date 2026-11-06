import { sleep } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

import {
	attachmentKind,
	buildAttachments,
	decodeText,
} from '../nodes/Localmind/resources/conversation/attachments';
import { Deadline } from '../nodes/shared/polling';
import { API } from './fakeConversation';
import { routedContext } from './helpers';

vi.mock('n8n-workflow', async (importOriginal) => ({
	...(await importOriginal<typeof import('n8n-workflow')>()),
	sleep: vi.fn(async () => undefined),
}));

describe('attachmentKind', () => {
	it.each([
		['image/png', 'a.png', 'image'],
		['image/jpeg', 'a.jpg', 'image'],
		['image/webp', 'a.webp', 'image'],
		['image/tiff', 'a.tif', undefined],
		['image/heic', 'a.heic', undefined],
		['image/svg+xml', 'a.svg', 'text'],
		['text/plain', 'a.txt', 'text'],
		['application/json', 'a.json', 'text'],
		['application/vnd.api+json', 'a', 'text'],
		['application/octet-stream', 'notes.md', 'text'],
		['application/pdf', 'a.pdf', undefined],
		[
			'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			'a.docx',
			undefined,
		],
	])('%s (%s) → %s', (mimeType, fileName, expected) => {
		expect(attachmentKind(mimeType, fileName)).toBe(expected);
	});
});

describe('decodeText', () => {
	it('reads UTF-8, UTF-16 by byte-order mark, and Windows text as Latin-1', () => {
		expect(decodeText(Buffer.from('Grüße', 'utf8'))).toBe('Grüße');
		expect(decodeText(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('Grüße')]))).toBe('Grüße');
		expect(decodeText(Buffer.from([0xff, 0xfe, ...Buffer.from('Grüße', 'utf16le')]))).toBe('Grüße');
		expect(decodeText(Buffer.from('Grüße', 'latin1'))).toBe('Grüße');
	});
});

describe('buildAttachments', () => {
	const binary = {
		photo: { mimeType: 'image/png', fileName: 'photo.png', data: 'png-bytes' },
		notes: { mimeType: 'text/csv', fileName: 'notes.csv', data: 'a,b\n1,2' },
		contract: { mimeType: 'application/pdf', fileName: 'contract.pdf', data: '%PDF' },
		sheet: {
			mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			fileName: 'Übersicht "Q3".xlsx',
			data: 'xlsx',
		},
		copy: { mimeType: 'application/pdf', fileName: 'contract.pdf', data: '%PDF-2' },
	};
	const conversation = { id: 'c1', space_id: 's1', agent_id: 'ag1' };
	const reference = (name: string) => ({
		type: 'file',
		content: `text of ${name}`,
		url: null,
		filename: name,
		media_type: 'application/pdf',
		object_path: `chat_attachments/s1/run/${name}`,
		meta: { parser: 'pdf', truncated: false },
	});
	type Request = { method: string; url: string; body?: unknown; qs?: Record<string, unknown> };
	const uploadedName = (request: Request) =>
		/filename="([^"]*)"/.exec(Buffer.from(request.body as Buffer).toString('utf8'))?.[1];
	/** The conversation's space and agent, as Send Message reads them once a file is uploaded. */
	const newTarget = () =>
		vi.fn(async () => ({ conversationId: 'c1', spaceId: 's1', agentId: 'ag1' }));

	/** Localmind 1.7.0: each upload starts a run that is still running once, then done. */
	function localmind17(
		run: (name: string) => object = (name) => ({
			status: 'COMPLETED',
			result_data: reference(name),
		}),
	) {
		const polls = new Map<string, number>();
		return (options: Request) => {
			if (options.method === 'GET' && options.url === `${API}/conversations/c1`) {
				return { body: conversation };
			}
			if (options.url === `${API}/chat/attachments/parse-async`) {
				return {
					statusCode: 202,
					body: { run_id: `run:${uploadedName(options)}`, status: 'PENDING' },
				};
			}
			const runId = /\/pipeline\/(.+)$/.exec(options.url)?.[1];
			if (runId) {
				const name = decodeURIComponent(runId).slice('run:'.length);
				const seen = polls.get(name) ?? 0;
				polls.set(name, seen + 1);
				return { body: seen === 0 ? { status: 'RUNNING' } : run(name) };
			}
			return undefined;
		};
	}

	it('uploads every file but images for the conversation, and sends the references as they are (1.7.0)', async () => {
		const { context, requests } = routedContext(localmind17(), {}, binary);

		const attachments = await buildAttachments.call(
			context,
			0,
			['photo', 'contract', 'notes'],
			newTarget(),
			new Deadline(60_000),
		);

		expect(attachments).toEqual([
			{
				type: 'image',
				url: `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`,
				filename: 'photo.png',
				media_type: 'image/png',
			},
			reference('contract.pdf'),
			reference('notes.csv'),
		]);
		const uploads = requests.filter((request) => request.url.endsWith('/parse-async'));
		expect(uploads.map(uploadedName)).toEqual(['contract.pdf', 'notes.csv']);
		expect(uploads[0].qs).toEqual({
			space_id: 's1',
			persist: 'true',
			conversation_id: 'c1',
			agent_id: 'ag1',
		});
	});

	it('keeps umlauts in the uploaded name, makes quotes safe and numbers duplicates', async () => {
		const { context, requests } = routedContext(localmind17(), {}, binary);

		await buildAttachments.call(
			context,
			0,
			['sheet', 'contract', 'copy'],
			newTarget(),
			new Deadline(60_000),
		);

		expect(
			requests.filter((request) => request.url.endsWith('/parse-async')).map(uploadedName),
		).toEqual(['Übersicht %22Q3%22.xlsx', 'contract.pdf', 'contract (2).pdf']);
	});

	it('uploads nothing and reads no conversation for images alone', async () => {
		const { context, requests } = routedContext(localmind17(), {}, binary);
		const target = newTarget();

		await buildAttachments.call(context, 0, ['photo'], target, new Deadline(60_000));

		expect(target).not.toHaveBeenCalled();
		expect(requests).toEqual([]);
	});

	it.each([
		['upload_type_requires_skill', 'has no skill'],
		['upload_type_disabled', 'switched off for the organization or the space'],
		['upload_type_unsupported', 'does not take this file type'],
	])('explains the refusal %s', async (code, explanation) => {
		const { context } = routedContext(
			(options: Request) =>
				options.url.endsWith('/parse-async')
					? { statusCode: 400, body: { detail: 'Refused', code } }
					: localmind17()(options),
			{},
			binary,
		);

		await expect(
			buildAttachments.call(context, 0, ['contract'], newTarget(), new Deadline(60_000)),
		).rejects.toMatchObject({
			message: `Localmind refused the attachment "contract.pdf" (${code})`,
			description: expect.stringContaining(explanation),
		});
	});

	it('does not take an unknown code for a refusal, even one named like an object property', async () => {
		const { context } = routedContext(
			(options: Request) =>
				options.url.endsWith('/parse-async')
					? { statusCode: 400, body: { detail: 'Refused', code: 'constructor' } }
					: localmind17()(options),
			{},
			binary,
		);

		const error = (await buildAttachments
			.call(context, 0, ['contract'], newTarget(), new Deadline(60_000))
			.catch((caught: unknown) => caught)) as Error;

		expect(error.message).toContain('Refused');
		expect(error.message).not.toContain('refused the attachment');
	});

	it('reports a file Localmind could not process, with a hint for spreadsheets only', async () => {
		const failing = () =>
			routedContext(
				localmind17(() => ({ status: 'FAILED', stages: [{ last_error: 'Could not read it.' }] })),
				{},
				binary,
			).context;

		await expect(
			buildAttachments.call(failing(), 0, ['contract'], newTarget(), new Deadline(60_000)),
		).rejects.toMatchObject({
			message: 'Localmind could not process the attachment "contract.pdf"',
			description: 'Could not read it.',
		});
		await expect(
			buildAttachments.call(failing(), 0, ['sheet'], newTarget(), new Deadline(60_000)),
		).rejects.toMatchObject({
			description: expect.stringMatching(/^Could not read it\. A spreadsheet too large/),
		});
	});

	it('sends a text file inline when the space does not take its type as an upload', async () => {
		const { context, requests } = routedContext(
			(options: Request) =>
				options.url.endsWith('/parse-async')
					? { statusCode: 400, body: { detail: 'Off', code: 'upload_type_disabled' } }
					: localmind17()(options),
			{},
			{ config: { mimeType: 'application/octet-stream', fileName: 'app.yaml', data: 'a: 1' } },
		);

		expect(
			await buildAttachments.call(context, 0, ['config'], newTarget(), new Deadline(60_000)),
		).toEqual([
			{
				type: 'file',
				content: 'a: 1',
				filename: 'app.yaml',
				media_type: 'application/octet-stream',
			},
		]);
		expect(requests.filter((request) => request.url.endsWith('/parse-async'))).toHaveLength(1);
	});

	it('names a file without a name after its type, since Localmind refuses a name without extension', async () => {
		const { context, requests } = routedContext(
			localmind17(),
			{},
			{
				data: { mimeType: 'application/pdf', data: '%PDF' },
				other: { mimeType: 'application/x-custom', fileExtension: 'xlsx', data: 'xlsx' },
			},
		);

		await buildAttachments.call(context, 0, ['data', 'other'], newTarget(), new Deadline(60_000));

		expect(
			requests.filter((request) => request.url.endsWith('/parse-async')).map(uploadedName),
		).toEqual(['data.pdf', 'other.xlsx']);
	});

	it('says so when a refused file has no extension', async () => {
		const { context } = routedContext(
			(options: Request) =>
				options.url.endsWith('/parse-async')
					? { statusCode: 400, body: { detail: 'No', code: 'upload_type_unsupported' } }
					: localmind17()(options),
			{},
			{ data: { mimeType: 'application/octet-stream', data: 'bytes' } },
		);

		await expect(
			buildAttachments.call(context, 0, ['data'], newTarget(), new Deadline(60_000)),
		).rejects.toMatchObject({
			message: 'Localmind refused the attachment "data" (upload_type_unsupported)',
			description: expect.stringContaining('"data" has none'),
		});
	});

	it('recognises a JPEG, PNG, GIF or WebP image sent as a generic type, and sends it to the model', async () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
		const { context, requests } = routedContext(
			localmind17(),
			{},
			{
				data: { mimeType: 'application/octet-stream', data: png },
			},
		);

		expect(
			await buildAttachments.call(context, 0, ['data'], newTarget(), new Deadline(60_000)),
		).toEqual([
			{
				type: 'image',
				url: `data:image/png;base64,${png.toString('base64')}`,
				filename: 'data',
				media_type: 'image/png',
			},
		]);
		expect(requests).toEqual([]);
	});

	it('points to a conversion when Localmind refuses another image type', async () => {
		const { context } = routedContext(
			(options: Request) =>
				options.url.endsWith('/parse-async')
					? { statusCode: 400, body: { detail: 'No', code: 'upload_type_unsupported' } }
					: localmind17()(options),
			{},
			{ scan: { mimeType: 'image/tiff', fileName: 'scan.tif', data: 'II*' } },
		);

		await expect(
			buildAttachments.call(context, 0, ['scan'], newTarget(), new Deadline(60_000)),
		).rejects.toMatchObject({
			description: expect.stringContaining('Convert other images to JPEG, PNG, GIF or WebP'),
		});
	});

	it('checks every field before the first upload, so a missing one leaves no upload behind', async () => {
		const { context, requests } = routedContext(localmind17(), {}, binary);

		await expect(
			buildAttachments.call(context, 0, ['contract', 'missing'], newTarget(), new Deadline(60_000)),
		).rejects.toThrow('No binary field "missing"');
		expect(requests).toEqual([]);
	});

	it('stops at the timeout while the file is processed', async () => {
		const { context } = routedContext(
			localmind17(() => ({ status: 'RUNNING' })),
			{},
			binary,
		);

		await expect(
			buildAttachments.call(context, 0, ['contract'], newTarget(), new Deadline(0)),
		).rejects.toMatchObject({
			message: expect.stringContaining('did not process the attachment "contract.pdf" within'),
		});
		expect(sleep).not.toHaveBeenCalledWith(expect.any(Number) as never);
	});

	describe('on Localmind up to 1.6.0, whose upload route takes no API key', () => {
		const before17 = (options: Request) => {
			if (options.method === 'GET' && options.url === `${API}/conversations/c1`) {
				return { body: conversation };
			}
			if (options.url.endsWith('/parse-async')) {
				return { statusCode: 401, body: { detail: 'Not authenticated' } };
			}
			return undefined;
		};

		it('sends text files inline, tried once', async () => {
			const { context, requests } = routedContext(
				before17,
				{},
				{
					...binary,
					more: { mimeType: 'text/plain', fileName: 'more.txt', data: 'more' },
				},
			);

			expect(
				await buildAttachments.call(
					context,
					0,
					['notes', 'more'],
					newTarget(),
					new Deadline(60_000),
				),
			).toEqual([
				{ type: 'file', content: 'a,b\n1,2', filename: 'notes.csv', media_type: 'text/csv' },
				{ type: 'file', content: 'more', filename: 'more.txt', media_type: 'text/plain' },
			]);
			expect(requests.filter((request) => request.url.endsWith('/parse-async'))).toHaveLength(1);
		});

		it('learns it once per execution: later items upload nothing', async () => {
			const { context, requests } = routedContext(before17, {}, binary);
			const target = newTarget();

			await buildAttachments.call(context, 0, ['notes'], target, new Deadline(60_000));
			await buildAttachments.call(context, 1, ['notes'], target, new Deadline(60_000));
			await expect(
				buildAttachments.call(context, 2, ['contract'], target, new Deadline(60_000)),
			).rejects.toThrow('cannot be attached');

			expect(requests.filter((request) => request.url.endsWith('/parse-async'))).toHaveLength(1);
		});

		it('refuses PDF and Office files with a pointer to Localmind 1.7.0', async () => {
			const { context } = routedContext(before17, {}, binary);

			await expect(
				buildAttachments.call(context, 0, ['contract'], newTarget(), new Deadline(60_000)),
			).rejects.toMatchObject({
				message: expect.stringContaining('"contract.pdf" (application/pdf) cannot be attached'),
				description: expect.stringContaining('need Localmind 1.7.0'),
			});
		});
	});
});
