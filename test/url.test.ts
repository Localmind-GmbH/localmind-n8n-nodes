import { describe, expect, it } from 'vitest';

import { apiUrlForAppHost, isEncryptedOrLocalUrl, normalizeBaseUrl } from '../nodes/shared/url';

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

describe('isEncryptedOrLocalUrl', () => {
	it.each([
		'https://acme-api.example.com',
		'  HTTPS://acme-api.example.com/v1/ ',
		'http://localhost',
		'http://localhost:8000/v1',
		'http://dev-api.localhost',
		'http://dev-api.localhost/',
		'http://127.0.0.1:8000',
		'http://127.1.2.3',
		'http://[::1]:8000/',
	])('allows %s', (url) => {
		expect(isEncryptedOrLocalUrl(url)).toBe(true);
	});

	it.each([
		'http://acme-api.example.com',
		'http://10.0.0.5:8000',
		'http://192.168.1.20',
		'http://localhost.evil.com',
		'http://localhost@evil.com',
		'http://dev-api.localhost@evil.com',
		'http://127.0.0.1.evil.com',
		'http://evil.com/localhost',
		'http://evil.com\\.localhost',
		'http://evil.com\\.localhost/v1',
		'http://a\\b.localhost',
		'http://localhost\\@evil.com',
		'http://127.0.0.1\\@evil.com',
		'http://[::1]\\@evil.com',
		'http://user@dev-api.localhost',
		'http://dev_api.localhost',
		'ftp://acme-api.example.com',
		'acme-api.example.com',
		'',
	])('refuses %s', (url) => {
		expect(isEncryptedOrLocalUrl(url)).toBe(false);
	});

	it.each([
		'http://localhost:8000/v1',
		'http://dev-api.localhost',
		'http://a.b.localhost/',
		'http://127.0.0.1',
		'http://[::1]:8000',
	])('only allows plain http where a URL parser also sees this machine: %s', (url) => {
		expect(isEncryptedOrLocalUrl(url)).toBe(true);
		const { hostname } = new URL(`${url.replace(/\/+$/, '')}/v1/models`);
		expect(
			hostname === 'localhost' ||
				hostname.endsWith('.localhost') ||
				/^127\.|^\[::1\]$/.test(hostname),
		).toBe(true);
	});
});
