import type { IDataObject } from 'n8n-workflow';

// One line, one closing bracket: "[Error: none found] Rows: [a, b]" is an answer, not a failure.
const AGENT_ERROR = /^\s*\[Error: ([^\]\n]*)\]\s*$/;

/**
 * The failure text when an answer is one of Localmind's in-band error reports.
 *
 * Once an agent run has started acting, the OpenAI-compatible endpoint reports failures as a
 * normal answer whose whole content is "[Error: …]" (in a stream: one chunk with that content).
 */
export function agentErrorFromAnswer(text: string): string | undefined {
	return AGENT_ERROR.exec(text)?.[1];
}

// The notice ends the answer (in a stream: the last chunk, after the partial answer).
const STEP_LIMIT_START = 'The assistant paused after reaching the maximum number of steps (';
// Anchored at the notice found with lastIndexOf, so the check stays linear in the answer's length.
const STEP_LIMIT =
	/^The assistant paused after reaching the maximum number of steps \((\d+)\) for a single run\.[^\n]*$/;

/**
 * The agent's step limit when an answer ends with Localmind's notice that the run stopped there.
 *
 * The OpenAI-compatible endpoint reports a run that hit the limit as a normal answer with that
 * notice and finish reason "length"; the answer is incomplete.
 */
export function stepLimitFromAnswer(text: string): number | undefined {
	const start = text.lastIndexOf(STEP_LIMIT_START);
	const limit = start < 0 ? undefined : STEP_LIMIT.exec(text.slice(start).trimEnd())?.[1];
	return limit === undefined ? undefined : Number(limit);
}

/** The error message for a run that stopped at the agent's step limit. */
export function stepLimitMessage(limit?: number): string {
	const steps = typeof limit === 'number' ? ` (${limit})` : '';
	return `The agent stopped after reaching its maximum number of steps${steps}`;
}

/** The error message when no code sandbox was free for the agent. */
export const SANDBOX_BUSY_MESSAGE =
	'No code-execution slot was free, so the agent could not run its code';

/**
 * Whether an answer of the OpenAI-compatible endpoint reports that no code sandbox was free.
 *
 * From Localmind 1.6.0 such a request ends with a fixed sentence ("Alle Rechenressourcen sind
 * derzeit belegt – …") instead of the agent's answer: HTTP 200, finish reason "stop", and
 * `notice.code` "sandbox_busy" on the response (in a stream: on the last chunk). The notice wins
 * over a later timeout, step limit or failure, and replaces JSON output.
 */
export function isSandboxBusy(notice: unknown): boolean {
	return isObject(notice) && notice.code === 'sandbox_busy';
}

function isObject(value: unknown): value is IDataObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationDetail(entries: unknown[]): string {
	return entries
		.map((entry) => {
			if (!isObject(entry)) return String(entry);
			const location = Array.isArray(entry.loc) ? entry.loc.join('.') : '';
			const message = typeof entry.msg === 'string' ? entry.msg : JSON.stringify(entry);
			return location ? `${location}: ${message}` : message;
		})
		.join('; ');
}

function errorCode(body: IDataObject): string | undefined {
	const nested = isObject(body.error) ? body.error.code : undefined;
	const code = body.error_code ?? body.code ?? nested;
	return typeof code === 'string' && code ? code : undefined;
}

/**
 * The human-readable detail of a Localmind error body, or undefined when the body carries none
 * (for example nginx's HTML pages).
 *
 * Handles the API's shapes: `{"detail": "…"}` with an optional `code` or `error_code`,
 * validation errors as `{"detail": [{"loc": […], "msg": "…"}]}`, and the OpenAI-compatible
 * endpoints' `{"error": {"message": "…", "code": "…"}}`.
 */
export function errorDetail(body: unknown): string | undefined {
	if (typeof body === 'string') {
		const text = body.trim();
		if (!text || text.startsWith('<')) return undefined;
		return text.length > 300 ? `${text.slice(0, 300)}…` : text;
	}
	if (!isObject(body)) return undefined;

	let detail: string | undefined;
	if (isObject(body.error) && typeof body.error.message === 'string') {
		detail = body.error.message;
	} else if (typeof body.detail === 'string') {
		detail = body.detail;
	} else if (Array.isArray(body.detail)) {
		detail = validationDetail(body.detail);
	} else if (typeof body.message === 'string') {
		detail = body.message;
	}
	if (!detail) return undefined;

	const code = errorCode(body);
	return code && code !== detail ? `${detail} (${code})` : detail;
}
