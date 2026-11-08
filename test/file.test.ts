import { sleep, type ILoadOptionsFunctions } from 'n8n-workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeFile } from '../nodes/Localmind/resources/file/execute';
import { entriesIn, getFolders, type FileEntry } from '../nodes/Localmind/resources/file/folders';
import { multipartBody } from '../nodes/Localmind/resources/file/multipart';
import { executeJob } from '../nodes/Localmind/resources/job/execute';
import { API } from './fakeConversation';
import { routedContext } from './helpers';

vi.mock('n8n-workflow', async (importOriginal) => ({
	...(await importOriginal<typeof import('n8n-workflow')>()),
	sleep: vi.fn(async (ms: number) => {
		vi.setSystemTime(Date.now() + ms);
	}),
}));

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.mocked(sleep).mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

const searchBody = (requests: Array<{ body?: unknown }>, index: number) =>
	requests[index].body as { filters: { user_path: string } };

const sleeps = () => vi.mocked(sleep).mock.calls.map(([ms]) => ms as number);

describe('multipartBody', () => {
	it('builds text fields and one file', () => {
		const { body, contentType } = multipartBody(
			{ path: 'contracts/Angebot Müller.pdf' },
			{
				field: 'file',
				fileName: 'Angebot "Müller".pdf',
				mimeType: 'application/pdf',
				data: Buffer.from('%PDF'),
			},
			'BOUNDARY',
		);

		expect(contentType).toBe('multipart/form-data; boundary=BOUNDARY');
		expect(body.toString()).toBe(
			'--BOUNDARY\r\nContent-Disposition: form-data; name="path"\r\n\r\ncontracts/Angebot Müller.pdf\r\n' +
				'--BOUNDARY\r\nContent-Disposition: form-data; name="file"; filename="Angebot _M_ller_.pdf"\r\n' +
				'Content-Type: application/pdf\r\n\r\n%PDF\r\n--BOUNDARY--\r\n',
		);
	});
});

describe('entriesIn', () => {
	const entries: FileEntry[] = [
		{ name: 'contracts', path: 'contracts/', type: 'folder' },
		{ name: '2024', path: 'contracts/2024/', type: 'folder' },
		{ name: 'offer.pdf', path: 'contracts/2024/offer.pdf', type: 'file' },
		{ name: 'old', path: 'contracts/2024/old/', type: 'folder' },
		{ name: 'v1.pdf', path: 'contracts/2024/old/v1.pdf', type: 'file' },
	];

	it('keeps the direct children and leaves out the folder and its ancestors', () => {
		expect(entriesIn(entries, 'contracts/2024', false).map((e) => e.path)).toEqual([
			'contracts/2024/offer.pdf',
			'contracts/2024/old/',
		]);
	});

	it('includes subfolders on request', () => {
		expect(entriesIn(entries, 'contracts/2024', true)).toHaveLength(3);
	});

	it('lists linked library folders at the top level', () => {
		const linked = [
			...entries,
			{ name: 'Policies', path: '@linked-1/Policies/', type: 'folder', linked: true },
		];
		expect(entriesIn(linked, '', false).map((e) => e.path)).toEqual([
			'contracts/',
			'@linked-1/Policies/',
		]);
	});

	it('lists the top level', () => {
		expect(entriesIn(entries, '', false).map((e) => e.path)).toEqual(['contracts/']);
	});
});

const archiveReads: Record<string, object[]> = {};

describe('File → Upload', () => {
	const binary = { data: { mimeType: 'application/pdf', fileName: 'offer.pdf', data: '%PDF' } };
	const uploaded = {
		relative_path: 'contracts/offer.pdf',
		size: 4,
		renamed: false,
		job_id: 'run-1',
	};

	it('uploads into the folder and waits until the document is indexed', async () => {
		const states = [{ parsed: true, embedded: false }, { pipeline_status: 'completed' }];
		const { context, requests } = routedContext(
			(options) => {
				if (options.url === `${API}/spaces/s1/data/upload`) return { body: uploaded };
				if (options.url === `${API}/data/search`) {
					return { body: { items: [{ id: 'd1', processing_state: states.shift() ?? states[0] }] } };
				}
				return undefined;
			},
			{ space: 's1', binaryPropertyName: 'data', folder: '/contracts/', options: {} },
			binary,
		);

		const [item] = await executeFile.call(context, 'upload', 0);

		expect(requests[0].headers?.['content-type']).toMatch(/^multipart\/form-data; boundary=/);
		expect((requests[0].body as Buffer).toString()).toContain(
			'name="path"\r\n\r\ncontracts/offer.pdf\r\n',
		);
		expect(searchBody(requests, 1)).toEqual({
			filters: { space_id: 's1', user_path: 'contracts/offer.pdf' },
		});
		expect(item.json).toEqual({
			spaceId: 's1',
			path: 'contracts/offer.pdf',
			size: 4,
			renamed: false,
			runId: 'run-1',
			documentId: 'd1',
			status: 'completed',
		});
	});

	it('adds the detected extension to a file name without one', async () => {
		const { context, requests } = routedContext(
			(options) =>
				options.url === `${API}/spaces/s1/data/upload`
					? { body: { relative_path: 'invoice.pdf', job_id: null } }
					: { body: { items: [] } },
			{ space: 's1', binaryPropertyName: 'data', options: {} },
			{
				data: {
					mimeType: 'application/pdf',
					fileName: 'invoice',
					fileExtension: 'pdf',
					data: '%PDF',
				},
			},
		);

		await executeFile.call(context, 'upload', 0);

		expect((requests[0].body as Buffer).toString()).toContain('name="path"\r\n\r\ninvoice.pdf\r\n');
	});

	it('fails when processing fails', async () => {
		const { context } = routedContext(
			(options) => {
				if (options.url === `${API}/spaces/s1/data/upload`) return { body: uploaded };
				return {
					body: {
						items: [
							{
								id: 'd1',
								processing_state: {
									pipeline_status: 'failed',
									error: 'Corrupt PDF',
									failed_stage: 'parse',
								},
							},
						],
					},
				};
			},
			{ space: 's1', binaryPropertyName: 'data', options: {} },
			binary,
		);

		await expect(executeFile.call(context, 'upload', 0)).rejects.toMatchObject({
			message: 'Localmind: Corrupt PDF',
			description: expect.stringContaining('at the parse stage'),
		});
	});

	it('stops waiting when the processing run was cancelled', async () => {
		const { context } = routedContext(
			(options) => {
				if (options.url === `${API}/spaces/s1/data/upload`) return { body: uploaded };
				if (options.url === `${API}/pipeline/run-1`) return { body: { status: 'CANCELLED' } };
				return { body: { items: [{ id: 'd1', processing_state: { parsed: false } }] } };
			},
			{ space: 's1', binaryPropertyName: 'data', options: {} },
			binary,
		);

		await expect(executeFile.call(context, 'upload', 0)).rejects.toMatchObject({
			message: 'Localmind: Processing was cancelled',
			description: expect.stringContaining('Document → Reprocess (document d1)'),
		});
		expect(sleeps().reduce((sum, ms) => sum + ms, 0)).toBeLessThan(60_000);
	});

	it('keeps waiting without the run when the key cannot read it', async () => {
		let reads = 0;
		const { context, requests } = routedContext(
			(options) => {
				if (options.url === `${API}/spaces/s1/data/upload`) return { body: uploaded };
				if (options.url === `${API}/pipeline/run-1`) {
					return { statusCode: 404, body: { detail: 'Pipeline run not found' } };
				}
				reads += 1;
				const status = reads > 15 ? { pipeline_status: 'completed' } : {};
				return { body: { items: [{ id: 'd1', processing_state: status }] } };
			},
			{ space: 's1', binaryPropertyName: 'data', options: {} },
			binary,
		);

		const [item] = await executeFile.call(context, 'upload', 0);

		expect(item.json).toMatchObject({ documentId: 'd1', status: 'completed' });
		expect(requests.filter((r) => r.url === `${API}/pipeline/run-1`)).toHaveLength(1);
	});

	it('returns at once for a file Localmind only stores', async () => {
		const { context } = routedContext(
			(options) =>
				options.url === `${API}/spaces/s1/data/upload`
					? { body: { relative_path: 'call.mp3', job_id: null } }
					: { body: { items: [] } },
			{ space: 's1', binaryPropertyName: 'data', options: {} },
			{ data: { mimeType: 'audio/mpeg', fileName: 'call.mp3', data: 'ID3' } },
		);

		const [item] = await executeFile.call(context, 'upload', 0);

		expect(item.json).toMatchObject({
			path: 'call.mp3',
			runId: null,
			documentId: null,
			status: 'stored',
		});
	});

	it('does not wait for audio, which Localmind only stores', async () => {
		const { context } = routedContext(
			(options) =>
				options.url === `${API}/spaces/s1/data/upload`
					? { body: { relative_path: 'call.mp3', job_id: 'run-7' } }
					: { body: { items: [{ id: 'd7', processing_state: { pipeline_status: 'failed' } }] } },
			{ space: 's1', binaryPropertyName: 'data', options: {} },
			{ data: { mimeType: 'audio/mpeg', fileName: 'call.mp3', data: 'ID3' } },
		);

		const [item] = await executeFile.call(context, 'upload', 0);

		expect(item.json).toMatchObject({
			path: 'call.mp3',
			runId: 'run-7',
			documentId: 'd7',
			status: 'stored',
		});
	});

	it('waits for the documents of the files extracted from an archive', async () => {
		const processing: Record<string, object[]> = {
			'contracts/a.pdf': [{ parsed: false }, { pipeline_status: 'completed' }],
		};
		const { context } = routedContext(
			(options) => {
				if (options.url === `${API}/spaces/s1/data/upload`) {
					return {
						body: {
							relative_path: 'contracts/bundle.zip',
							job_id: null,
							extracted_files: ['contracts/a.pdf', 'contracts/readme.exe'],
							extraction_job_ids: ['run-a'],
						},
					};
				}
				const path = (options.body as { filters: { user_path: string } }).filters.user_path;
				const states = processing[path];
				if (!states) return { body: { items: [] } };
				return {
					body: {
						items: [
							{ id: 'doc-a', processing_state: states.length > 1 ? states.shift() : states[0] },
						],
					},
				};
			},
			{ space: 's1', binaryPropertyName: 'data', folder: 'contracts', options: {} },
			{ data: { mimeType: 'application/zip', fileName: 'bundle.zip', data: 'PK' } },
		);

		const [item] = await executeFile.call(context, 'upload', 0);

		expect(item.json).toMatchObject({
			path: 'contracts/bundle.zip',
			documentId: null,
			status: 'extracted',
			extractedFiles: [
				{ path: 'contracts/a.pdf', documentId: 'doc-a', status: 'completed' },
				{ path: 'contracts/readme.exe', documentId: null, status: 'stored' },
			],
		});
	});

	it('lists a failed file of an archive instead of failing the whole upload', async () => {
		const { context } = routedContext(
			(options) => {
				if (options.url === `${API}/spaces/s1/data/upload`) {
					return {
						body: {
							relative_path: 'x.zip',
							job_id: null,
							extracted_files: ['bad.pdf', 'good.pdf'],
						},
					};
				}
				const path = (options.body as { filters: { user_path: string } }).filters.user_path;
				const reads: Record<string, object[]> = {
					'bad.pdf': [{}, { pipeline_status: 'failed', error: 'Corrupt PDF' }],
					'good.pdf': [{}, { pipeline_status: 'completed' }],
				};
				const states = (archiveReads[path] ??= [...reads[path]]);
				return {
					body: {
						items: [{ id: path, processing_state: states.length > 1 ? states.shift() : states[0] }],
					},
				};
			},
			{ space: 's1', binaryPropertyName: 'data', options: {} },
			{ data: { mimeType: 'application/zip', fileName: 'x.zip', data: 'PK' } },
		);

		const [item] = await executeFile.call(context, 'upload', 0);

		expect(item.json.extractedFiles).toEqual([
			{
				path: 'bad.pdf',
				documentId: 'bad.pdf',
				status: 'failed',
				errorMessage: 'Localmind: Corrupt PDF',
			},
			{ path: 'good.pdf', documentId: 'good.pdf', status: 'completed' },
		]);
	});

	it('refuses a timeout that is not a positive number', async () => {
		const { context, requests } = routedContext(
			() => ({ body: uploaded }),
			{
				space: 's1',
				binaryPropertyName: 'data',
				options: { timeoutMinutes: 'soon' },
			},
			binary,
		);

		await expect(executeFile.call(context, 'upload', 0)).rejects.toMatchObject({
			message: '\'Timeout (Minutes)\' must be a positive number, not "soon"',
		});
		expect(requests).toHaveLength(0);
	});
});

describe('File → Download', () => {
	it('fetches the link path from the credential host into the chosen binary field', async () => {
		const { context, requests } = routedContext(
			(options) => {
				if (options.url === `${API}/spaces/s1/data/download`) {
					return {
						body: {
							url: 'https://other-host/v1/storage/download/org-1/spaces/s1/data/Rechnung #12.pdf?org_id=1',
						},
					};
				}
				if (
					options.url ===
					'https://acme-api.example.com/v1/storage/download/org-1/spaces/s1/data/Rechnung%20%2312.pdf'
				) {
					return { body: Buffer.from('%PDF'), headers: { 'content-type': 'application/pdf' } };
				}
				return undefined;
			},
			{ space: 's1', path: '/Rechnung #12.pdf', binaryPropertyName: 'invoice' },
		);

		const [item] = await executeFile.call(context, 'download', 0);

		expect(requests[0].qs).toEqual({ path: 'Rechnung #12.pdf' });
		expect(item.json).toEqual({ fileName: 'Rechnung #12.pdf', size: 4 });
		expect(item.binary?.invoice).toMatchObject({
			fileName: 'Rechnung #12.pdf',
			mimeType: 'application/pdf',
		});
	});

	it('keeps a link copied from a browser as it is', async () => {
		const { context, requests } = routedContext(() => ({ body: Buffer.from('x') }), {
			url: 'https://acme-app.example.com/v1/storage/download/org-1/out/Q3%20report.xlsx',
			binaryPropertyName: 'data',
		});

		await executeFile.call(context, 'downloadByUrl', 0);

		expect(requests[0].url).toBe(`${API}/storage/download/org-1/out/Q3%20report.xlsx`);
	});
});

describe('file-manager paths', () => {
	it("uses the last part of a binary's file name that carries a path", async () => {
		const { context, requests } = routedContext(
			() => ({ body: { relative_path: 'offer.pdf', status: 'stored' } }),
			{ space: 's1', binaryPropertyName: 'data', options: { waitForProcessing: false } },
			{ data: { mimeType: 'application/pdf', fileName: 'C:\\fakepath\\offer.pdf', data: '%PDF' } },
		);

		await executeFile.call(context, 'upload', 0).catch(() => undefined);

		expect(Buffer.from(requests[0].body as Buffer).toString()).toContain(
			'name="path"\r\n\r\noffer.pdf',
		);
	});

	it('refuses an upload file name with a slash, which would pick another folder', async () => {
		const { context, requests } = routedContext(
			() => ({ body: {} }),
			{ space: 's1', binaryPropertyName: 'data', options: { fileName: 'other/offer.pdf' } },
			{ data: { mimeType: 'application/pdf', fileName: 'offer.pdf', data: '%PDF' } },
		);

		await expect(executeFile.call(context, 'upload', 0)).rejects.toThrow('has a "/" or');
		expect(requests).toEqual([]);
	});

	it.each([
		['move', { path: 'contracts/offer.pdf', newPath: '../other-space/offer.pdf' }],
		['delete', { path: 'contracts/./offer.pdf' }],
		['download', { path: 'a\\..\\b.pdf' }],
	])('refuses "." and ".." segments before sending anything (%s)', async (operation, params) => {
		const { context, requests } = routedContext(() => ({ body: {} }), { space: 's1', ...params });

		await expect(executeFile.call(context, operation, 0)).rejects.toThrow('"." or ".." segment');
		expect(requests).toEqual([]);
	});
});

describe('Job → Get', () => {
	it('waits until the run has finished and reports its error', async () => {
		const statuses = ['RUNNING', 'RUNNING', 'FAILED'];
		const { context } = routedContext(
			() => ({
				body: {
					id: 'run-1',
					status: statuses.shift(),
					stages: [{ last_error: null }, { last_error: 'Parser crashed' }],
				},
			}),
			{ runId: 'run-1', options: { waitUntilFinished: true } },
		);

		const [item] = await executeJob.call(context, 'get', 0);

		expect(item.json).toMatchObject({
			status: 'FAILED',
			finished: true,
			errorMessage: 'Parser crashed',
		});
		expect(vi.mocked(sleep)).toHaveBeenCalledTimes(2);
	});

	it('returns the current state without waiting', async () => {
		const { context } = routedContext(
			() => ({ body: { id: 'run-1', status: 'RUNNING', stages: [] } }),
			{ runId: 'run-1' },
		);

		const [item] = await executeJob.call(context, 'get', 0);

		expect(item.json).toMatchObject({ status: 'RUNNING', finished: false });
		// n8n 2.16 counts any item with an "error" key as failed.
		expect(item.json).not.toHaveProperty('error');
	});

	it('explains an empty run ID, for example from an upload without a run', async () => {
		const { context } = routedContext(() => undefined, { runId: null });

		await expect(executeJob.call(context, 'get', 0)).rejects.toMatchObject({
			message: 'The run ID is empty',
		});
	});
});

describe('Folder dropdown', () => {
	it('offers only the top level, without a request, when the space is set by expression', async () => {
		const httpRequestWithAuthentication = vi.fn();
		const context = {
			getCurrentNodeParameter: () => '={{ $json.spaceId }}',
			getCredentials: async () => ({ url: 'https://acme-api.example.com', apiKey: 'k' }),
			getNode: () => ({ name: 'Localmind' }),
			helpers: { httpRequestWithAuthentication },
		} as unknown as ILoadOptionsFunctions;

		expect(await getFolders.call(context)).toEqual([{ name: '/ (Top Level)', value: '' }]);
		expect(httpRequestWithAuthentication).not.toHaveBeenCalled();
	});
});
