import { randomString } from 'n8n-workflow';

export interface MultipartFile {
	field: string;
	fileName: string;
	mimeType: string;
	data: Buffer;
}

// The header file name only helps the server guess the type; the stored name comes from "path".
const headerSafe = (value: string) => value.replace(/[^\x20-\x7e]|["\\]/g, '_');

/** A multipart/form-data body with text fields and one file, built without a form library. */
export function multipartBody(
	fields: Record<string, string>,
	file: MultipartFile,
	boundary = `----LocalmindN8n${randomString(24)}`,
): { body: Buffer; contentType: string } {
	const parts: Buffer[] = [];
	for (const [name, value] of Object.entries(fields)) {
		parts.push(
			Buffer.from(
				`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
			),
		);
	}
	parts.push(
		Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${headerSafe(file.fileName)}"\r\nContent-Type: ${safeMimeType(file.mimeType)}\r\n\r\n`,
		),
		file.data,
		Buffer.from(`\r\n--${boundary}--\r\n`),
	);
	return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** A MIME type safe for a header line; anything else (for example with line breaks) becomes generic. */
export function safeMimeType(mimeType: string): string {
	return /^[\w.+-]+\/[\w.+-]+(?:\s*;\s*[\w.+-]+=[\w.+"-]+)*$/.test(mimeType)
		? mimeType
		: 'application/octet-stream';
}
