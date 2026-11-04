import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { isAcceptedImage } from '../../../shared/files';

const TEXT_MIME_TYPES = new Set([
	'application/json',
	'application/xml',
	'application/yaml',
	'application/x-yaml',
	'application/csv',
	'application/javascript',
	'application/x-ndjson',
	'application/sql',
]);

const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|log|html?|ini|toml|sql)$/i;

/** How a binary file can go into a conversation message: as an image, as inline text, or not at all. */
export function attachmentKind(mimeType: string, fileName = ''): 'image' | 'text' | undefined {
	const mime = mimeType.toLowerCase().split(';')[0].trim();
	if (isAcceptedImage(mime)) return 'image';
	// SVG is XML text; other image types are not accepted.
	if (mime.startsWith('image/') && !mime.endsWith('+xml')) return undefined;
	if (
		mime.startsWith('text/') ||
		TEXT_MIME_TYPES.has(mime) ||
		mime.endsWith('+json') ||
		mime.endsWith('+xml') ||
		TEXT_EXTENSIONS.test(fileName)
	) {
		return 'text';
	}
	return undefined;
}

/**
 * The text of a file: UTF-16 and UTF-8 by their byte-order mark, otherwise UTF-8 when the bytes
 * are valid UTF-8, else Latin-1 (close to Windows-1252, which many Windows tools still write).
 */
export function decodeText(buffer: Buffer): string {
	if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
	if (buffer[0] === 0xfe && buffer[1] === 0xff) {
		const body = Buffer.from(buffer.subarray(2, buffer.length - (buffer.length % 2)));
		return body.swap16().toString('utf16le');
	}
	if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
		return buffer.subarray(3).toString('utf8');
	}
	const text = buffer.toString('utf8');
	// Invalid UTF-8 turns into replacement characters, so the text no longer encodes to the same bytes.
	return Buffer.from(text, 'utf8').equals(buffer) ? text : buffer.toString('latin1');
}

/**
 * The attachments of a message from the item's binary properties: images as data URIs, text
 * files inline. Other files are refused: the API cannot take them from an API key yet.
 */
export async function buildAttachments(
	this: IExecuteFunctions,
	itemIndex: number,
	propertyNames: string[],
): Promise<IDataObject[]> {
	const attachments: IDataObject[] = [];
	for (const name of propertyNames) {
		const binary = this.helpers.assertBinaryData(itemIndex, name);
		const fileName = binary.fileName ?? name;
		const kind = attachmentKind(binary.mimeType, fileName);
		if (!kind) {
			throw new NodeOperationError(
				this.getNode(),
				`"${fileName}" (${binary.mimeType}) cannot be attached to a conversation message`,
				{
					itemIndex,
					description:
						'Conversations take JPEG, PNG, GIF and WebP images and text files. Convert other images first, or send PDF and Office documents with Agent → Ask.',
				},
			);
		}
		const buffer = await this.helpers.getBinaryDataBuffer(itemIndex, name);
		attachments.push(
			kind === 'image'
				? {
						type: 'image',
						url: `data:${binary.mimeType};base64,${buffer.toString('base64')}`,
						filename: fileName,
						media_type: binary.mimeType,
					}
				: {
						type: 'file',
						content: decodeText(buffer),
						filename: fileName,
						media_type: binary.mimeType,
					},
		);
	}
	return attachments;
}
