/**
 * A parameter value as text. Expressions can yield numbers, arrays or null where the node
 * expects a string; this keeps `.split` and `.trim` from failing on them.
 */
export function textParam(value: unknown): string {
	if (value === undefined || value === null) return '';
	if (Array.isArray(value)) return value.map((entry) => textParam(entry)).join(',');
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
	}
	if (typeof value === 'object') {
		const prototype = Object.getPrototypeOf(value) as unknown;
		// A plain object from an expression as JSON, not as "[object Object]". Anything else keeps
		// its own text: {{ $now }} is a Luxon DateTime, whose JSON would come with quotes.
		if (prototype !== Object.prototype && prototype !== null) return String(value);
		try {
			return JSON.stringify(value);
		} catch {
			// A circular or BigInt value: no JSON, but no failure either.
			return '[object Object]';
		}
	}
	return String(value);
}

/** Splits a comma-separated parameter value ("data, invoice") into trimmed, non-empty entries. */
export function commaList(value: unknown): string[] {
	return textParam(value)
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/** A file-manager folder path without leading or trailing slashes; "" is the top level. */
export function normalizeFolder(folder: unknown): string {
	const text = textParam(folder);
	// By hand: a pattern over long runs of slashes would take quadratic time.
	const edge = (char: string) => char === '/' || char.trim() === '';
	let start = 0;
	let end = text.length;
	while (start < end && edge(text[start])) start++;
	while (end > start && edge(text[end - 1])) end--;
	return text.slice(start, end);
}

/** A Localmind ID, as the regex source a resource locator's validation takes. */
export const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const UUID_PATTERN = new RegExp(UUID);

/** An ID for a JSON filter. Localmind compares its lowercase UUIDs case-sensitively there. */
export function idParam(value: unknown): string {
	const id = textParam(value).trim();
	return UUID_PATTERN.test(id) ? id.toLowerCase() : id;
}
