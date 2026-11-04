import { describe, expect, it } from 'vitest';

import {
	attachmentKind,
	buildAttachments,
	decodeText,
} from '../nodes/Localmind/resources/conversation/attachments';
import { routedContext } from './helpers';

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
	};

	it('sends images as data URIs and text files inline', async () => {
		const { context } = routedContext(() => undefined, {}, binary);

		expect(await buildAttachments.call(context, 0, ['photo', 'notes'])).toEqual([
			{
				type: 'image',
				url: `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`,
				filename: 'photo.png',
				media_type: 'image/png',
			},
			{ type: 'file', content: 'a,b\n1,2', filename: 'notes.csv', media_type: 'text/csv' },
		]);
	});

	it('refuses files the API cannot take from a key', async () => {
		const { context } = routedContext(() => undefined, {}, binary);

		await expect(buildAttachments.call(context, 0, ['contract'])).rejects.toMatchObject({
			message: expect.stringContaining('"contract.pdf" (application/pdf) cannot be attached'),
		});
	});
});
