import { describe, expect, it } from 'vitest';

import { apiUrlForAppHost, normalizeBaseUrl } from '../nodes/shared/url';

describe('normalizeBaseUrl', () => {
	it.each([
		['https://acme-api.example.com', 'https://acme-api.example.com'],
		['https://acme-api.example.com/', 'https://acme-api.example.com'],
		['https://acme-api.example.com/v1', 'https://acme-api.example.com'],
		['https://acme-api.example.com/v1/', 'https://acme-api.example.com'],
		['  https://acme-api.example.com/V1//  ', 'https://acme-api.example.com'],
		['https://example.com/localmind/v1', 'https://example.com/localmind'],
	])('%s → %s', (input, expected) => {
		expect(normalizeBaseUrl(input)).toBe(expected);
	});
});

describe('apiUrlForAppHost', () => {
	it('suggests the -api host for an -app host', () => {
		expect(apiUrlForAppHost('https://acme-app.example.com/v1')).toBe(
			'https://acme-api.example.com',
		);
	});

	it('keeps the port', () => {
		expect(apiUrlForAppHost('http://acme-app.local:8443/')).toBe('http://acme-api.local:8443');
	});

	it.each([
		'https://acme-api.example.com',
		'https://app.example.com',
		'https://my-apps.example.com',
		'not a url',
	])('returns undefined for %s', (input) => {
		expect(apiUrlForAppHost(input)).toBeUndefined();
	});
});
