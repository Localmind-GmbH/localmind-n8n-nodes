import { describe, expect, it } from 'vitest';

import {
	binaryMimeType,
	downloadLinkPath,
	downloadPath,
	generatedFilePath,
	safeFileName,
	specificMimeType,
} from '../nodes/shared/files';

describe('downloadPath', () => {
	it('strips /v1 and encodes a raw file name', () => {
		expect(downloadPath('/v1/storage/download/org-1/out/Q3 report#1.xlsx')).toBe(
			'/storage/download/org-1/out/Q3%20report%231.xlsx',
		);
	});

	it('encodes percent signs in raw names literally', () => {
		expect(downloadPath('/v1/storage/download/org-1/out/Growth 5%20.xlsx')).toBe(
			'/storage/download/org-1/out/Growth%205%2520.xlsx',
		);
		expect(downloadPath('/v1/storage/download/org-1/out/report%FF.csv')).toBe(
			'/storage/download/org-1/out/report%25FF.csv',
		);
	});
});

describe('downloadLinkPath', () => {
	it.each([
		'/v1/storage/download/../../conversations',
		'/v1/storage/download/org-1/%2E%2E/%2e%2e/conversations',
		'/v1/storage/download/org-1/..%2F..%2Fconversations',
		'/v1/storage/download/org-1/./report.xlsx',
	])('refuses a link that leaves the download endpoint: %s', (link) => {
		expect(downloadLinkPath(link, 'auto')).toBeUndefined();
		expect(downloadLinkPath(link, 'raw')).toBeUndefined();
	});

	it.each([
		// A "?" in the link must not hide the segments after it: it is encoded into the name.
		'/v1/storage/download/org-1/a?/../../../../conversations/c1/messages',
		'/v1/storage/download/org-1/report.xlsx?x=/../../../../agents',
		// An empty segment could make the backend misread the path.
		'/v1/storage/download/org-1//spaces/B/data/x.pdf',
		'/v1/storage/download/org-1/a%2F..%2F..%2Fagents',
		'/v1/storage/download/org-1/a%5C..%5Cagents',
		'/v1/storage/download/org-1/%252E%252E/agents',
	])('refuses %s', (link) => {
		expect(downloadLinkPath(link, 'auto')).toBeUndefined();
		expect(downloadLinkPath(link, 'raw')).toBeUndefined();
	});

	it('keeps file names with "%", "?" and "#" from the API', () => {
		expect(
			downloadLinkPath('/v1/storage/download/org-1/spaces/s1/data/50% off? #2.pdf', 'raw'),
		).toBe('/storage/download/org-1/spaces/s1/data/50%25%20off%3F%20%232.pdf');
	});

	it('keeps names that only contain dots', () => {
		expect(downloadLinkPath('/v1/storage/download/org-1/spaces/s1/data/v1..2.pdf', 'raw')).toBe(
			'/storage/download/org-1/spaces/s1/data/v1..2.pdf',
		);
	});

	it('keeps "#" and "?" of raw names and drops only the org_id query', () => {
		expect(
			downloadLinkPath(
				'https://backend.internal/v1/storage/download/org-1/spaces/s1/data/Why? #2.pdf?org_id=7f3a',
				'raw',
			),
		).toBe('/storage/download/org-1/spaces/s1/data/Why%3F%20%232.pdf');
		expect(downloadLinkPath('/v1/storage/download/org-1/x.xlsx', 'raw')).toBe(
			'/storage/download/org-1/x.xlsx',
		);
	});

	it('keeps a pasted link that is already encoded, and encodes a raw one', () => {
		expect(
			downloadLinkPath(
				'https://acme-app.example.com/v1/storage/download/org-1/Q3%20report.xlsx',
				'auto',
			),
		).toBe('/storage/download/org-1/Q3%20report.xlsx');
		expect(downloadLinkPath('/v1/storage/download/org-1/Q3 report.xlsx', 'auto')).toBe(
			'/storage/download/org-1/Q3%20report.xlsx',
		);
	});

	it('refuses other links', () => {
		expect(downloadLinkPath('https://example.com/file.pdf', 'auto')).toBeUndefined();
	});
});

describe('generatedFilePath', () => {
	const link = (name: string) => `/v1/storage/download/org-1/sandbox_outputs/o/c1/${name}`;
	const path = (name: string) => `/storage/download/org-1/sandbox_outputs/o/c1/${name}`;

	it('encodes a link that ends in the raw name (up to Localmind 1.6.0)', () => {
		expect(generatedFilePath(link('a b.xlsx'), 'a b.xlsx')).toBe(path('a%20b.xlsx'));
		expect(generatedFilePath(link('Growth_5%20.xlsx'), 'Growth_5%20.xlsx')).toBe(
			path('Growth_5%2520.xlsx'),
		);
		expect(generatedFilePath(link('report%FF.csv'), 'report%FF.csv')).toBe(path('report%25FF.csv'));
	});

	it('keeps a link that ends in the encoded name (from Localmind 1.7.0)', () => {
		expect(generatedFilePath(link('a%20b.xlsx'), 'a b.xlsx')).toBe(path('a%20b.xlsx'));
		expect(generatedFilePath(link('Growth_5%2520.xlsx'), 'Growth_5%20.xlsx')).toBe(
			path('Growth_5%2520.xlsx'),
		);
	});

	it('guesses when the name matches neither form', () => {
		expect(generatedFilePath(link('a%20b.xlsx'), undefined)).toBe(path('a%20b.xlsx'));
		expect(generatedFilePath(link('a b.xlsx'), 'other.xlsx')).toBe(path('a%20b.xlsx'));
	});

	it('still refuses links that leave the download endpoint', () => {
		expect(generatedFilePath(link('..'), '..')).toBeUndefined();
		expect(generatedFilePath(link('%2E%2E'), '..')).toBeUndefined();
	});
});

describe('specificMimeType', () => {
	it('drops the generic type so n8n detects it from the file name', () => {
		expect(specificMimeType('application/octet-stream')).toBeUndefined();
		expect(specificMimeType('image/png')).toBe('image/png');
		expect(specificMimeType(undefined)).toBeUndefined();
	});
});

describe('safeFileName', () => {
	it('keeps ordinary names, umlauts, spaces and brackets', () => {
		expect(safeFileName('Bericht Q3 (für Max).xlsx')).toBe('Bericht Q3 (für Max).xlsx');
	});

	it('keeps only the last path segment', () => {
		expect(safeFileName('../../etc/passwd')).toBe('passwd');
		expect(safeFileName('C:\\Users\\x\\report.pdf')).toBe('report.pdf');
		expect(safeFileName('folder/')).toBe('file');
		expect(safeFileName('..')).toBe('file');
	});

	it('drops control characters and the marks that disguise an extension', () => {
		expect(safeFileName('report\r\nX-Injected: 1.pdf')).toBe('reportX-Injected: 1.pdf');
		expect(safeFileName('report\u202Efdp.exe')).toBe('reportfdp.exe');
		expect(safeFileName('a\u2066b\u2069.txt')).toBe('ab.txt');
	});

	it('shortens a very long name but keeps its extension', () => {
		const name = safeFileName(`${'x'.repeat(500)}.xlsx`);
		expect(name).toHaveLength(200);
		expect(name.endsWith('.xlsx')).toBe(true);
	});

	it('counts bytes, so that a long Chinese name fits the 255 bytes of a file system', () => {
		const name = safeFileName(`${'报'.repeat(100)}.xlsx`);
		expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200);
		expect(name).toBe(`${'报'.repeat(65)}.xlsx`);
	});

	it('never splits a character such as an emoji when shortening', () => {
		const name = safeFileName(`${'😀'.repeat(300)}.txt`);
		expect(Array.from(name)).toHaveLength(49 + 4);
		expect(name.endsWith('.txt')).toBe(true);
		expect(name).not.toMatch(
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
		);
	});

	it('falls back to "file" for an empty name', () => {
		expect(safeFileName(undefined)).toBe('file');
		expect(safeFileName('\u0000\u0007')).toBe('file');
	});
});

describe('binaryMimeType', () => {
	it('takes the first specific and well-formed type', () => {
		expect(binaryMimeType('application/octet-stream', 'image/png')).toBe('image/png');
		expect(binaryMimeType('text/plain; charset=utf-8')).toBe('text/plain; charset=utf-8');
	});

	it('drops a type with line breaks or other header tricks', () => {
		expect(binaryMimeType('text/html\r\nX-Injected: 1')).toBeUndefined();
		expect(binaryMimeType('text/html\r\nX-Injected: 1', 'application/pdf')).toBe('application/pdf');
		expect(binaryMimeType(undefined, '')).toBeUndefined();
	});
});
