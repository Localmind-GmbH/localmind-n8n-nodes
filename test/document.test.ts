import { describe, expect, it, vi } from 'vitest';

import {
	executeDocument,
	mergeMetadata,
	pathInTree,
} from '../nodes/Localmind/resources/document/execute';
import { API } from './fakeConversation';
import { routedContext } from './helpers';

vi.mock('n8n-workflow', async (importOriginal) => ({
	...(await importOriginal<typeof import('n8n-workflow')>()),
	sleep: vi.fn(async () => {}),
}));

const DOC = 'd1';
const root = {
	name: 'All files',
	path: '/',
	type: 'folder',
	children: [
		{ name: 'notes.txt', path: 'file:d0', type: 'file', document_id: 'd0' },
		{
			name: 'contracts',
			path: 'contracts',
			type: 'folder',
			children: [
				{
					name: '2024',
					path: 'contracts/2024',
					type: 'folder',
					children: [{ name: 'offer.pdf', path: `file:${DOC}`, type: 'file', document_id: DOC }],
				},
			],
		},
	],
};
// GET /v1/data/folders/{space} wraps the tree.
const folderTree = { space_id: 's1', folders: [root], total_documents: 2, include_files: true };

describe('mergeMetadata', () => {
	it('sets and adds fields, removes null fields, keeps Localmind fields', () => {
		expect(
			mergeMetadata(
				{ original_filename: 'offer.pdf', project: 'Q2', owner: 'Ana' },
				{ project: 'Q3', status: 'signed', owner: null, original_filename: null },
			),
		).toEqual({ original_filename: 'offer.pdf', project: 'Q3', status: 'signed' });
	});
});

describe('pathInTree', () => {
	it('finds files at the top level and in nested folders of the wrapped tree', () => {
		expect(pathInTree(folderTree, 'd0')).toBe('notes.txt');
		expect(pathInTree(folderTree, DOC)).toBe('contracts/2024/offer.pdf');
		expect(pathInTree(folderTree, 'missing')).toBeUndefined();
		expect(pathInTree({}, DOC)).toBeUndefined();
	});
});

describe('Document → Search', () => {
	it('searches with weights that add up to 1, normalized folders, and drops low scores', async () => {
		const { context, requests } = routedContext(
			() => ({
				body: {
					results: [
						{
							document_id: DOC,
							document_name: 'offer.pdf',
							text: 'Price: 10k',
							score: 0.82,
							chunk_index: 3,
						},
						{ document_id: 'd2', text: 'unrelated', score: 0.21 },
					],
				},
			}),
			{
				space: 's1',
				query: 'price of the offer',
				limit: 5,
				options: {
					semanticWeight: 0.65,
					minScore: 0.5,
					folders: 'contracts/2024/, /invoices/*',
				},
			},
		);

		const items = await executeDocument.call(context, 'search', 0);

		expect(requests[0]).toMatchObject({
			url: `${API}/data/hybrid-search`,
			body: {
				space_id: 's1',
				query: 'price of the offer',
				top_k: 5,
				dense_weight: 0.65,
				sparse_weight: 0.35,
				folders: ['contracts/2024', 'invoices/*'],
			},
		});
		expect(items.map((item) => item.json.documentId)).toEqual([DOC]);
		expect(items[0].json).toMatchObject({
			documentName: 'offer.pdf',
			text: 'Price: 10k',
			chunkIndex: 3,
		});
	});

	it("shows Localmind's explanation when nothing is found", async () => {
		const { context } = routedContext(
			() => ({ body: { results: [], message: 'No documents found in specified folders' } }),
			{ space: 's1', query: 'x', options: { folders: 'nowhere' } },
		);

		const items = await executeDocument.call(context, 'search', 0);

		expect(items).toEqual([]);
		expect(context.addExecutionHints).toHaveBeenCalledWith({
			message: 'Localmind: No documents found in specified folders',
			location: 'outputPane',
		});
	});
});

describe('Document operations', () => {
	it('joins the text of pages in order, or returns one item per page', async () => {
		const units = {
			body: {
				content_units: [
					{ unit_index: 1, unit_type: 'PAGE', text: 'Page two' },
					{ unit_index: 0, unit_type: 'PAGE', text: 'Page one', unit_metadata: { page_number: 1 } },
				],
			},
		};
		const joined = routedContext(() => units, { document: DOC, textOutput: 'joined' });
		const perPage = routedContext(() => units, { document: DOC, textOutput: 'units' });

		expect((await executeDocument.call(joined.context, 'getText', 0))[0].json).toEqual({
			documentId: DOC,
			text: 'Page one\n\nPage two',
			units: 2,
		});
		const pages = await executeDocument.call(perPage.context, 'getText', 0);
		expect(pages.map((page) => page.json.text)).toEqual(['Page one', 'Page two']);
		expect(pages[0].json.metadata).toEqual({ page_number: 1 });
	});

	it('lists documents with filters', async () => {
		const { context, requests } = routedContext(
			() => ({ body: { items: [], page: 1, total_pages: 1, total_items: 0, page_size: 50 } }),
			{
				returnAll: false,
				limit: 50,
				filters: { spaceId: 's1', fileTypes: ['PDF'], folder: '/contracts/', name: 'offer' },
			},
		);

		await executeDocument.call(context, 'getAll', 0);

		expect(requests[0].body).toEqual({
			filters: {
				space_id: 's1',
				file_type__in: ['PDF'],
				user_path__startswith: 'contracts/',
				user_path__contains: 'offer',
			},
			order_by: ['-created_at', 'id'],
		});
	});

	it('sends a body with Reprocess, which n8n would otherwise drop', async () => {
		const { context, requests } = routedContext(
			() => ({ statusCode: 202, body: { pipeline_run_id: 'run-9', version_number: 2 } }),
			{ document: DOC },
		);

		const [item] = await executeDocument.call(context, 'reprocess', 0);

		expect(requests[0]).toMatchObject({
			method: 'POST',
			url: `${API}/data/${DOC}/reprocess`,
			body: '{}',
			headers: { 'content-type': 'application/json' },
		});
		expect(item.json).toMatchObject({ documentId: DOC, runId: 'run-9', versionNumber: 2 });
	});

	it('merges metadata into the current one before writing it', async () => {
		const { context, requests } = routedContext(
			(options) =>
				options.method === 'GET'
					? {
							body: {
								id: DOC,
								space_id: 's1',
								doc_metadata: { original_filename: 'offer.pdf', project: 'Q2' },
							},
						}
					: { body: { id: DOC } },
			{ document: DOC, metadata: '{"project": "Q3"}' },
		);

		await executeDocument.call(context, 'updateMetadata', 0);

		expect(requests[1]).toMatchObject({
			method: 'PATCH',
			url: `${API}/data/${DOC}`,
			body: { doc_metadata: { original_filename: 'offer.pdf', project: 'Q3' } },
		});
	});

	it('refuses an empty update, so an unedited node writes nothing', async () => {
		const { context, requests } = routedContext(() => ({ body: {} }), {
			document: DOC,
			metadata: '{}',
		});

		await expect(executeDocument.call(context, 'updateMetadata', 0)).rejects.toMatchObject({
			message: 'Metadata is empty: there is nothing to update',
		});
		expect(requests).toHaveLength(0);
	});
});

describe('Document → Delete', () => {
	/** A space whose search finds the document only under `currentPath`. */
	const space =
		(document: object, currentPath: string | undefined) =>
		(options: { method: string; url: string; body?: unknown }) => {
			if (options.method === 'GET' && options.url === `${API}/data/${DOC}`) {
				return { body: { id: DOC, space_id: 's1', ...document } };
			}
			if (options.url === `${API}/data/folders/s1`) return { body: folderTree };
			if (options.url === `${API}/data/search`) {
				const path = (options.body as { filters: { user_path: string } }).filters.user_path;
				return {
					body: {
						items: path === currentPath ? [{ id: DOC, space_id: 's1' }] : [],
						total_pages: 1,
					},
				};
			}
			if (options.method === 'DELETE') return { statusCode: 204, body: '' };
			return undefined;
		};

	it('finds the file under its stored path without loading the folder tree', async () => {
		const { context, requests } = routedContext(
			space({ file_path: 'spaces/s1/data/contracts/2024/offer.pdf' }, 'contracts/2024/offer.pdf'),
			{ document: DOC },
		);

		const [item] = await executeDocument.call(context, 'delete', 0);

		expect(requests.map((r) => r.url)).not.toContain(`${API}/data/folders/s1`);
		expect(requests.at(-1)).toMatchObject({
			method: 'DELETE',
			url: `${API}/spaces/s1/data/files`,
			qs: { path: 'contracts/2024/offer.pdf' },
		});
		expect(item.json).toEqual({
			deleted: true,
			documentId: DOC,
			path: 'contracts/2024/offer.pdf',
			recordOnly: false,
		});
	});

	it('finds a moved file in the folder tree', async () => {
		const { context, requests } = routedContext(
			space({ file_path: 'spaces/s1/data/old/offer.pdf' }, 'contracts/2024/offer.pdf'),
			{ document: DOC },
		);

		const [item] = await executeDocument.call(context, 'delete', 0);

		expect(requests.map((r) => r.url)).toContain(`${API}/data/folders/s1`);
		expect(item.json.path).toBe('contracts/2024/offer.pdf');
	});

	it('deletes the record when the document has no file in the file manager', async () => {
		const { context, requests } = routedContext(space({}, undefined), { document: DOC });

		const [item] = await executeDocument.call(context, 'delete', 0);

		expect(requests.at(-1)).toMatchObject({ method: 'DELETE', url: `${API}/data/${DOC}` });
		expect(item.json).toMatchObject({ path: null, recordOnly: true });
		// Localmind's record delete leaves the stored file and the search entries behind.
		expect(context.addExecutionHints).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining('Only the document record') }),
		);
	});

	it('does not delete through the file manager when another document shares the path', async () => {
		const { context, requests } = routedContext(
			(options) => {
				if (options.method === 'GET' && options.url === `${API}/data/${DOC}`) {
					return { body: { id: DOC, space_id: 's1', file_path: 'spaces/s1/data/sales.csv' } };
				}
				if (options.url === `${API}/data/search`) {
					// Like the backend, at most `limit` items: with limit 1 the guard would see only one.
					const limit = Number((options.qs as { limit?: number } | undefined)?.limit ?? 50);
					const items = [{ id: DOC }, { id: 'table-doc' }].slice(0, limit);
					return { body: { items, total_pages: 1 } };
				}
				if (options.url === `${API}/data/folders/s1`) return { body: folderTree };
				if (options.method === 'DELETE') return { statusCode: 204, body: '' };
				return undefined;
			},
			{ document: DOC },
		);

		const [item] = await executeDocument.call(context, 'delete', 0);

		expect(requests.map((r) => r.url)).not.toContain(`${API}/spaces/s1/data/files`);
		expect(requests.at(-1)).toMatchObject({ method: 'DELETE', url: `${API}/data/${DOC}` });
		expect(item.json.path).toBeNull();
	});

	it('deletes the record when Localmind already removed the stored file', async () => {
		const { context, requests } = routedContext(
			space({ file_path: 'spaces/s1/data/sales.csv', source_file_deleted: true }, 'sales.csv'),
			{ document: DOC },
		);

		await executeDocument.call(context, 'delete', 0);

		expect(requests.map((r) => r.url)).not.toContain(`${API}/spaces/s1/data/files`);
		expect(requests.at(-1)).toMatchObject({ method: 'DELETE', url: `${API}/data/${DOC}` });
	});
});

describe('Search with document IDs and folders', () => {
	it('lets Localmind match the folders and searches only the given documents inside them', async () => {
		const { context, requests } = routedContext(
			(options) => {
				if (options.url === `${API}/data/search/folders`) {
					return {
						body: {
							document_ids: [
								'aaaaaaaa-0000-4000-8000-000000000001',
								'aaaaaaaa-0000-4000-8000-000000000003',
							],
						},
					};
				}
				return {
					body: { results: [{ document_id: 'aaaaaaaa-0000-4000-8000-000000000001', score: 0.9 }] },
				};
			},
			{
				space: 's1',
				query: 'x',
				options: {
					documentIds: 'AAAAAAAA-0000-4000-8000-000000000001, d2',
					folders: 'contracts/',
				},
			},
		);

		const items = await executeDocument.call(context, 'search', 0);

		expect(items.map((item) => item.json.documentId)).toEqual([
			'aaaaaaaa-0000-4000-8000-000000000001',
		]);
		expect(requests[0]).toMatchObject({ body: { space_id: 's1', folders: ['contracts'] } });
		expect(requests[1].body).toMatchObject({
			document_ids: ['aaaaaaaa-0000-4000-8000-000000000001'],
		});
		expect(requests[1].body).not.toHaveProperty('folders');
	});

	it('returns nothing, with a hint, when no given document lies in the folders', async () => {
		const { context, requests } = routedContext(() => ({ body: { document_ids: ['d9'] } }), {
			space: 's1',
			query: 'x',
			options: { documentIds: 'd1', folders: 'contracts' },
		});

		const items = await executeDocument.call(context, 'search', 0);

		expect(items).toEqual([]);
		expect(requests).toHaveLength(1);
		expect(context.addExecutionHints).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'None of the given documents lies in the given folders' }),
		);
	});
});
