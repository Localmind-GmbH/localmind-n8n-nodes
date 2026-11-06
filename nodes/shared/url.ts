/**
 * The credential URL without trailing slashes and without a trailing "/v1",
 * so "https://acme-api.example.com/v1/" and "https://acme-api.example.com" both work.
 */
export function normalizeBaseUrl(url: string): string {
	return url.trim().replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/+$/, '');
}

/**
 * https, or plain http to this machine only: localhost, *.localhost, 127.x.x.x or [::1]. Plain http
 * to any other host would carry the API key and all data unencrypted. The credential applies the
 * same pattern in its expressions, so the key is never sent to such a URL. Subdomains of localhost
 * take only letters, digits and hyphens: URL parsers read "\" as "/", so "evil.com\.localhost"
 * would reach evil.com.
 */
export const ENCRYPTED_OR_LOCAL_URL =
	/^(?:https:\/\/|http:\/\/(?:localhost|(?:[a-z\d-]+\.)+localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$))/i;

/** Whether the API key may be sent to this credential URL (see `ENCRYPTED_OR_LOCAL_URL`). */
export function isEncryptedOrLocalUrl(url: string): boolean {
	return ENCRYPTED_OR_LOCAL_URL.test(url.trim());
}

const ORIGIN = /^(https?:\/\/)([^/:?#]+)(:\d+)?/i;

/**
 * The matching "-api" address when the URL points to a Localmind app host ("acme-app.…"),
 * which serves the web app but not the API. Undefined for any other URL.
 */
export function apiUrlForAppHost(url: string): string | undefined {
	const match = ORIGIN.exec(normalizeBaseUrl(url));
	if (!match) return undefined;
	const [, scheme, host, port = ''] = match;
	const [firstLabel, ...rest] = host.split('.');
	if (!/-app$/i.test(firstLabel)) return undefined;
	return `${scheme}${[firstLabel.replace(/-app$/i, '-api'), ...rest].join('.')}${port}`;
}
