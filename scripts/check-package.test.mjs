import { spawnSync } from 'node:child_process';
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Next to the script it tests: like the script, it needs the file system and a child process,
// which the lint rules for node code forbid.
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));

/** An unpacked package as the stage job checks it: the repository's package.json, the entry files. */
function unpacked(files = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'check-package-'));
	copyFileSync('package.json', join(dir, 'package.json'));
	const entries = [...manifest.n8n.credentials, ...manifest.n8n.nodes];
	for (const [path, text] of [...entries.map((entry) => [entry, '']), ...Object.entries(files)]) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	created.push(dir);
	return dir;
}

const created = [];
afterEach(() => {
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function check(dir) {
	const run = spawnSync('node', ['scripts/check-package.mjs', '--unpacked', dir], {
		encoding: 'utf8',
	});
	return { passed: run.status === 0, output: `${run.stdout}${run.stderr}` };
}

describe('the package check, as the stage job runs it', () => {
	it('passes a clean package', () => {
		expect(check(unpacked({ 'dist/nodes/a.js': 'const url = "https://localmind.ai";' }))).toEqual({
			passed: true,
			output: expect.stringContaining('nothing internal or secret found'),
		});
	});

	it.each([
		['an unexpected file', { 'notes.txt': 'x' }, 'not expected'],
		[
			'a link to another host',
			{ 'dist/nodes/a.js': '"https://cdn.jsdelivr.net/x"' },
			'unexpected host',
		],
		['an internal host name', { 'dist/nodes/a.js': 'const db = "pg.corp:5432";' }, 'internal host'],
		['an IPv6 address', { 'dist/nodes/a.js': 'const ip = "fd00::1:2";' }, 'IPv6'],
		['an IPv4 address', { 'dist/nodes/a.js': 'const ip = "10.0.0.7";' }, 'IP address'],
		['a ticket number', { 'dist/nodes/a.js': `// ${['LMD', '42'].join('-')}` }, 'ticket number'],
		['an email address', { 'dist/nodes/a.js': '"someone@corp.example.com"' }, 'email address'],
		['an SVG comment', { 'dist/icons/a.svg': '<svg><!-- by me --></svg>' }, 'comment'],
	])('refuses %s', (_case, files, finding) => {
		const result = check(unpacked(files));
		expect(result.passed).toBe(false);
		expect(result.output).toContain(finding);
	});

	it('takes neither times nor the loopback address for IPv6 addresses', () => {
		const files = { 'dist/nodes/a.js': 'const t = "12:30:45"; const local = "[::1]";' };
		expect(check(unpacked(files)).passed).toBe(true);
	});

	it("refuses a package.json other than the repository's", () => {
		const dir = unpacked();
		writeFileSync(join(dir, 'package.json'), JSON.stringify({ ...manifest, bin: { x: 'x.js' } }));
		expect(check(dir).output).toContain("package.json: missing, or differs from the repository's");
		rmSync(join(dir, 'package.json'));
		expect(check(dir).output).toContain('package.json: missing');
	});

	it('refuses links and other files that are not regular files', () => {
		const dir = unpacked();
		symlinkSync('/etc/hostname', join(dir, 'dist', 'nodes', 'link.js'));
		expect(check(dir).output).toContain('not a regular file');
	});
});
