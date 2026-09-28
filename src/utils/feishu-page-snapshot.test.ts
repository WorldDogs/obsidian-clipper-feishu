// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { beforeEach, describe, expect, test } from 'vitest';
import { isFeishuDocumentUrl, readFeishuPageSnapshot } from './feishu-page-snapshot';
import { renderFeishuSnapshot } from './feishu-renderer';

const url = 'https://example.feishu.cn/wiki/document';
type RecordMap = Record<string, { snapshot: Record<string, any> }>;

function records(data: Record<string, Record<string, any>>): RecordMap {
	return Object.fromEntries(Object.entries(data).map(([id, snapshot]) => [id, { snapshot }]));
}

// executeScript serializes only the function, not its module closure. Every
// snapshot test executes the serialized function in a fresh MAIN-world-like
// context so accidental external helper dependencies cannot go unnoticed.
function inPage(map: RecordMap | Map<string, { snapshot: Record<string, any> }>, options: { href?: string; service?: unknown; source?: string } = {}) {
	const href = options.href ?? url;
	const service = options.service ?? { rootRecordId: 'root', getRecordMap: () => map };
	const read = runInNewContext(`(${options.source ?? readFeishuPageSnapshot.toString()})`, {
		window: { PageMain: { editor: { editor: { api: { dataService: service } } } } },
		document,
		location: { href, hostname: new URL(href).hostname },
		Map,
	}) as typeof readFeishuPageSnapshot;
	return read;
}

beforeEach(() => {
	document.title = '完整测试文档 - 飞书云文档';
	document.body.innerHTML = '';
});

describe('Feishu document URL boundary', () => {
	test('accepts only HTTPS document routes on Feishu and Lark domains', () => {
		for (const value of [url, 'https://feishu.cn/docx/abc', 'https://team.larksuite.com/docs/abc?x=1#heading']) {
			expect(isFeishuDocumentUrl(value)).toBe(true);
		}
		for (const value of ['http://example.feishu.cn/wiki/document', 'https://feishu.cn.evil.example/wiki/document', 'https://evilfeishu.cn/wiki/document', 'https://example.feishu.cn/wiki/', 'https://example.feishu.cn/login', 'not a URL']) {
			expect(isFeishuDocumentUrl(value)).toBe(false);
		}
	});
});

describe('serialized Feishu page snapshot', () => {
	test('reads the full reachable record tree beyond the mounted viewport without copying unrelated records', () => {
		document.body.innerHTML = '<div data-record-id="first">First visible block</div>';
		const data = records({
			root: { type: 'page', children: ['first', 'tail'] },
			first: { type: 'text', text: 'First visible block' },
			tail: { type: 'text', text: 'Final offscreen block' },
			otherDocument: { type: 'text', text: 'Unrelated cached content' },
		});
		const result = inPage(data)(url);
		expect(result.error).toBeUndefined();
		expect(result.snapshot?.title).toBe('完整测试文档');
		expect(Object.keys(result.snapshot!.records).sort()).toEqual(['first', 'root', 'tail']);
		expect(renderFeishuSnapshot(result.snapshot!).content).toContain('Final offscreen block');
		// The transport result is detached from mutable live editor records.
		data.tail.snapshot.text = 'Changed later';
		expect(result.snapshot!.records.tail.snapshot.text).toBe('Final offscreen block');
	});

	test('supports Map-backed models and follows referenced sources without looping', () => {
		const data = records({
			root: { type: 'page', children: ['reference'] },
			reference: { type: 'synced_reference', src_block_id: 'source' },
			source: { type: 'text', text: 'Referenced content', children: ['root'] },
		});
		const result = inPage(new Map(Object.entries(data)))(url);
		expect(Object.keys(result.snapshot!.records).sort()).toEqual(['reference', 'root', 'source']);
		expect(result.snapshot!.records.source.snapshot.text).toBe('Referenced content');
	});

	test('retains missing child IDs so extraction cannot mistake unloaded blocks for complete content', () => {
		const result = inPage(records({ root: { type: 'page', children: ['loaded', 'missing'] }, loaded: { type: 'text', text: 'Loaded' } }))(url);
		expect(result.snapshot!.records.root.snapshot.children).toEqual(['loaded', 'missing']);
		expect(renderFeishuSnapshot(result.snapshot!).missingIds).toEqual(['missing']);
	});

	test('captures only observed HTTPS image URLs and strips controls from visible reference fallback', () => {
		document.body.innerHTML = '<div data-record-id="ref"><p>Visible reference</p><button>Control</button><script>unsafe()</script><style>.x{}</style><div class="block-comment">Comment</div></div><div data-record-id="image"><img></div><div data-record-id="blob"><img></div><div data-record-id="other"><img></div>';
		for (const [id, currentSrc] of [['image', 'https://images.example.com/observed.png'], ['blob', 'blob:https://example.feishu.cn/local'], ['other', 'https://images.example.com/unrelated.png']]) {
			Object.defineProperty(document.querySelector(`[data-record-id="${id}"] img`)!, 'currentSrc', { value: currentSrc });
		}
		const result = inPage(records({
			root: { type: 'page', children: ['ref', 'image', 'blob'] },
			ref: { type: 'synced_reference', src_block_id: 'external' },
			image: { type: 'image' }, blob: { type: 'image' },
		}))(url);
		expect(result.snapshot!.imageUrls).toEqual({ image: 'https://images.example.com/observed.png' });
		expect(result.snapshot!.domByRecordId).toEqual({ ref: '<p>Visible reference</p>' });
		const rendered = renderFeishuSnapshot(result.snapshot!);
		expect(rendered.warnings.some(value => value.includes('图片块 blob'))).toBe(true);
		expect(rendered.warnings.some(value => value.includes('引用块 ref'))).toBe(true);
	});

	test('rejects a changed page URL or lookalike host before reading the model', () => {
		const service = { get rootRecordId(): never { throw new Error('Must not access this document'); } };
		expect(inPage({}, { href: `${url}?navigated`, service })(url).error).toContain('文档地址已变化');
		const hostile = 'https://feishu.cn.evil.example/wiki/document';
		expect(inPage({}, { href: hostile, service })(hostile).error).toContain('文档地址已变化');
	});

	test('reports unavailable, missing-root, or unserializable model data explicitly', () => {
		expect(inPage({}, { service: {} })(url).error).toContain('尚未就绪');
		expect(inPage({})(url).error).toContain('未找到文档根节点');
		const circular: Record<string, any> = { type: 'page' };
		circular.self = circular;
		expect(inPage(records({ root: circular }))(url).error).toContain('无法读取当前文档模型');
	});

	test('remains self-contained after the production TypeScript ES2015 transformation', () => {
		const source = readFileSync('src/utils/feishu-page-snapshot.ts', 'utf8');
		const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2015, module: ts.ModuleKind.CommonJS } }).outputText;
		const moduleExports: Record<string, any> = {};
		runInNewContext(compiled, { exports: moduleExports });
		const serialized = moduleExports.readFeishuPageSnapshot.toString();
		const result = inPage(records({ root: { type: 'page', children: ['tail'] }, tail: { type: 'text', text: 'Last block' } }), { source: serialized })(url);
		expect(result.error).toBeUndefined();
		expect(result.snapshot!.records.tail.snapshot.text).toBe('Last block');
	});
});
