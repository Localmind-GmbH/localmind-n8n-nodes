/**
 * The credential URL without trailing slashes and without a trailing "/v1",
 * so "https://acme-api.example.com/v1/" and "https://acme-api.example.com" both work.
 */
export function normalizeBaseUrl(url: string): string {
	return url.trim().replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/+$/, '');
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
