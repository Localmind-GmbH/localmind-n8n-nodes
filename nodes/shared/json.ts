import { jsonParse } from 'n8n-workflow';

// jsonParse treats an undefined fallback as none and throws, so "not JSON" needs its own marker.
const NOT_JSON = Symbol('not JSON');

/**
 * The text inside a ``` fence (optionally ```json), or the text itself. By hand rather than with a
 * regular expression: the answer can be shaped by prompt injection, and a backtracking pattern
 * over long runs of whitespace would block n8n for minutes.
 */
function withoutFence(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length < 6 || !trimmed.startsWith('```') || !trimmed.endsWith('```')) return trimmed;
	const inner = trimmed.slice(3, -3);
	return (inner.slice(0, 4).toLowerCase() === 'json' ? inner.slice(4) : inner).trim();
}

/** The JSON in an answer, also when the model wrapped it in a ``` fence; undefined if it is not JSON. */
export function parseJsonAnswer(text: string): unknown {
	const parsed = jsonParse<unknown>(withoutFence(text), { fallbackValue: NOT_JSON });
	return parsed === NOT_JSON ? undefined : parsed;
}
