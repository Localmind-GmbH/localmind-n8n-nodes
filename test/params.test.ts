import { describe, expect, it } from 'vitest';

import { commaList, idParam, normalizeFolder, textParam } from '../nodes/shared/params';
import { timeoutMs } from '../nodes/shared/polling';
import { node } from './helpers';

describe('textParam', () => {
	it('turns what an expression yields into text', () => {
		expect(textParam(null)).toBe('');
		expect(textParam(undefined)).toBe('');
		expect(textParam(42)).toBe('42');
		expect(textParam(['data', 'invoice'])).toBe('data,invoice');
	});

	it('sends a plain object as JSON, but dates and the like as their own text', () => {
		expect(textParam({ subject: 'Invoice' })).toBe('{"subject":"Invoice"}');
		expect(textParam(Object.assign(Object.create(null), { a: 1 }))).toBe('{"a":1}');
		expect(textParam(new Date('2026-10-27T17:00:00Z'))).toBe('2026-10-27T17:00:00.000Z');
		// Like a Luxon DateTime from {{ $now }}: its JSON would be the text in quotes.
		class Stamp {
			toString() {
				return '2026-10-27T17:00:00.000+00:00';
			}
			toJSON() {
				return this.toString();
			}
		}
		expect(textParam(new Stamp())).toBe('2026-10-27T17:00:00.000+00:00');
	});

	it('does not fail on objects JSON cannot hold', () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(textParam(circular)).toBe('[object Object]');
	});
});

describe('commaList', () => {
	it('splits and trims, whatever the value', () => {
		expect(commaList(' data, invoice ,,')).toEqual(['data', 'invoice']);
		expect(commaList(['a', 'b'])).toEqual(['a', 'b']);
		expect(commaList(null)).toEqual([]);
		expect(commaList(undefined)).toEqual([]);
	});
});

describe('normalizeFolder', () => {
	it('strips slashes and spaces', () => {
		expect(normalizeFolder(' /contracts/2024/ ')).toBe('contracts/2024');
		expect(normalizeFolder('/')).toBe('');
		expect(normalizeFolder(null)).toBe('');
	});
});

describe('timeoutMs', () => {
	it('uses the default when the option is not set', () => {
		expect(timeoutMs(node, undefined, 0)).toBe(15 * 60_000);
		expect(timeoutMs(node, '', 0, 10)).toBe(10 * 60_000);
	});

	it('accepts numbers, also from expressions as text', () => {
		expect(timeoutMs(node, 2, 0)).toBe(120_000);
		expect(timeoutMs(node, '2', 0)).toBe(120_000);
	});

	it('refuses values that would make a polling loop run without pause', () => {
		expect(() => timeoutMs(node, 'soon', 0)).toThrow(
			"'Timeout (Minutes)' must be a positive number",
		);
		expect(() => timeoutMs(node, 0, 0)).toThrow('must be a positive number');
		expect(() => timeoutMs(node, Number.NaN, 0)).toThrow('must be a positive number');
	});
});

describe('idParam', () => {
	it('lower-cases UUIDs, which Localmind compares case-sensitively in filters', () => {
		expect(idParam(' 7C9E6679-7425-40DE-944B-E07FC1F90AE7 ')).toBe(
			'7c9e6679-7425-40de-944b-e07fc1f90ae7',
		);
		expect(idParam('Space-A')).toBe('Space-A');
	});
});

describe('textParam with an object from an expression', () => {
	it('sends JSON text instead of "[object Object]"', () => {
		expect(textParam({ order: 42, items: ['a'] })).toBe('{"order":42,"items":["a"]}');
		expect(textParam(['a', { b: 1 }])).toBe('a,{"b":1}');
	});
});
