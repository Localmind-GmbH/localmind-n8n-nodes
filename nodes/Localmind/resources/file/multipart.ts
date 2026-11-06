import { randomString } from 'n8n-workflow';

import { safeMimeType } from '../../../shared/files';

export interface MultipartFile {
	field: string;
	fileName: string;
	mimeType: string;
	data: Buffer;
	/**
	 * Send the file name as it is, in UTF-8 as browsers do, for an endpoint that stores the file
	 * under this name (a chat attachment). Otherwise it is reduced to ASCII: File → Upload's
	 * stored name comes from its "path" field, and this name only helps the server guess the type.
	 */
	exactName?: boolean;
}

const headerSafe = (value: string) => value.replace(/[^\x20-\x7e]|["\\]/g, '_');

/** A UTF-8 name as browsers send it: line breaks and quotes percent-encoded (WHATWG form encoding). */
const browserName = (value: string) =>
	value.replace(/[\r\n"]/g, (char) => encodeURIComponent(char));

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
			`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.exactName ? browserName(file.fileName) : headerSafe(file.fileName)}"\r\nContent-Type: ${safeMimeType(file.mimeType)}\r\n\r\n`,
		),
		file.data,
		Buffer.from(`\r\n--${boundary}--\r\n`),
	);
	return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
