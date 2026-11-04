// Checks what npm would publish: only the expected files, and nothing secret or internal in them.
// Runs before every publish (prepublishOnly) and in CI after the build. Findings name the file and
// line but never the matched text, so a leaked secret does not end up in the CI log.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** The only email address the package may contain: the author in package.json. */
const ALLOWED_EMAILS = new Set(['support@localmind.ai']);

const ALLOWED_FILES = [
	/^package\.json$/,
	/^README\.md$/,
	/^LICENSE(\.md)?$/,
	/^dist\/package\.json$/,
	/^dist\/(credentials|nodes|icons)\/.+\.(js|js\.map|d\.ts|json|svg|png)$/,
];

/**
 * The hosts links in the package may point to; any other could be an internal address. GitHub
 * links may point only to the package's own repository (see `isOwnRepository`).
 */
const ALLOWED_HOSTS = new Set([
	'localmind.ai',
	'www.npmjs.com',
	'docs.n8n.io',
	'www.w3.org',
	'localhost',
]);

/** Reserved example domains (RFC 2606), as in placeholders such as acme-api.example.com. */
const isExampleHost = (host) => /(^|\.)example\.(com|net|org)$/.test(host);

// Links of any scheme (https, wss, ssh, git+https, …); "${…}" stays in for template placeholders.
const LINK = /\b[a-z][a-z\d+.-]*:\/\/[^\s"'`<>()[\]\\]+/gi;

/**
 * The host and path a link points to, read as a URL so that user info ("https://a:b@host") cannot
 * hide the host. Trailing punctuation from the text around it is dropped, and a placeholder such
 * as "${host}" is no host. Undefined when nothing is left; a link that is no URL is kept as host.
 */
function linkTarget(link) {
	const trimmed = link.replace(/[.,;:!?*]+$/, '');
	try {
		const url = new URL(trimmed);
		const host = url.hostname.replace(/\$\{[^}]*\}\.?/g, '').toLowerCase();
		return host ? { host, path: url.pathname.toLowerCase() } : undefined;
	} catch {
		return { host: trimmed, path: '' };
	}
}

const FORBIDDEN = [
	['a mention of Bitbucket', /bitbucket/i],
	['a ticket number', /\bLMD-\d+/],
	[
		'an API key or token',
		/\bsk-[\w-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_\w{20,}|\bnpm_[A-Za-z0-9]{30,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|\beyJ[\w-]{10,}\.eyJ[\w-]{10,}/,
	],
	['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
	['a local path', /\/home\/[a-z_][\w-]*\/|\/Users\/[^/\s]+\/|\/opt\/stacks\/|[A-Za-z]:\\Users\\/],
	['an IP address', /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
];

/** Editors leave comments and metadata in SVGs, such as file paths and author names. */
const SVG_FORBIDDEN = [['a comment or editor metadata', /<!--|<metadata|inkscape:|sodipodi:/]];

const EMAIL = /[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

const [pack] = JSON.parse(
	execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }),
);
const files = pack.files.map((file) => file.path);
const problems = [];

for (const path of files) {
	if (!ALLOWED_FILES.some((pattern) => pattern.test(path))) {
		problems.push(`${path}: not expected in the package`);
	}
}

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
for (const entry of [...manifest.n8n.credentials, ...manifest.n8n.nodes]) {
	if (!files.includes(entry)) problems.push(`${entry}: missing, run the build first`);
}

// npm provenance needs repository.url, and it names the only GitHub location links may point to.
const repository = manifest.repository?.url
	? linkTarget(manifest.repository.url.replace(/^git\+/, ''))
	: undefined;
if (!repository?.path) problems.push('package.json: repository.url is missing or not a URL');
const repositoryPath = repository?.path.replace(/\.git$/, '');

/** Whether a link points into the package's own repository. */
const isOwnRepository = ({ host, path }) => {
	if (!repositoryPath || host !== repository.host) return false;
	const linkPath = path.replace(/\.git$/, '');
	return linkPath === repositoryPath || linkPath.startsWith(`${repositoryPath}/`);
};

for (const path of files) {
	const text = readFileSync(path, 'utf8');
	const checks = path.endsWith('.svg') ? [...FORBIDDEN, ...SVG_FORBIDDEN] : FORBIDDEN;
	for (const [what, pattern] of checks) {
		const match = pattern.exec(text);
		if (match) problems.push(`${path}:${lineOf(text, match.index)}: contains ${what}`);
	}
	// JSON and JavaScript strings may escape the slashes ("https:\/\/host").
	const unescaped = text.replaceAll('\\/', '/');
	for (const match of unescaped.matchAll(LINK)) {
		const target = linkTarget(match[0]);
		if (!target || ALLOWED_HOSTS.has(target.host) || isExampleHost(target.host)) continue;
		if (isOwnRepository(target)) continue;
		problems.push(
			`${path}:${lineOf(unescaped, match.index)}: contains a link to an unexpected host`,
		);
	}
	for (const match of text.matchAll(EMAIL)) {
		if (!ALLOWED_EMAILS.has(match[0].toLowerCase())) {
			problems.push(`${path}:${lineOf(text, match.index)}: contains an email address`);
		}
	}
	if (path.endsWith('.map') && JSON.parse(text).sourcesContent) {
		problems.push(`${path}: contains the source code`);
	}
}

if (problems.length > 0) {
	console.error(
		`The package is not ready to publish:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
	);
	process.exit(1);
}
console.log(`Package contents checked: ${files.length} files, nothing internal or secret found.`);
