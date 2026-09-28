import { describe, expect, test } from 'vitest';
import { FeishuSnapshot, renderFeishuSnapshot } from './feishu-renderer';

function text(value: string, attribs?: string, numToAttrib: Record<string, [string, string]> = {}) {
	return { apool: { numToAttrib }, initialAttributedTexts: { text: { '0': value }, attribs: { '0': attribs } } };
}

function document(records: Record<string, Record<string, any>>, children = Object.keys(records)): FeishuSnapshot {
	return {
		url: 'https://example.feishu.cn/wiki/document', title: 'Example', rootId: 'root',
		records: Object.fromEntries(Object.entries({ root: { type: 'page', children }, ...records }).map(([id, snapshot]) => [id, { id, snapshot }]))
	};
}

describe('renderFeishuSnapshot', () => {
	test('renders the document tree in order, including blocks absent from the visible DOM', () => {
		const input = document({ tail: { type: 'text', text: text('最后一段') }, first: { type: 'heading1', text: text('开始') } }, ['first', 'tail']);
		input.domByRecordId = { first: '<h1>开始</h1>' };
		const result = renderFeishuSnapshot(input);
		expect(result.content).toBe('<h1>开始</h1><p>最后一段</p>');
		expect(result.blockCount).toBe(3);
		expect(result.warnings).toEqual([]);
	});

	test('decodes base36 runs, formatting, encoded links and document mentions', () => {
		const mention = JSON.stringify({ type: 'mention_doc', data: { title: '引用文档', raw_url: 'https://example.feishu.cn/docx/linked' } });
		const input = document({ p: { type: 'text', text: text('0123456789ABCDEF链接尾巴 ', '*0+g*0*1+2*0+2*0*2*3+1', {
			'0': ['author', 'someone'], '1': ['link', 'https%3A%2F%2Fexample.com%2Fa%3Fx%3D1%26y%3D2'],
			'2': ['bold', 'true'], '3': ['inline-component', mention]
		}) } });
		const result = renderFeishuSnapshot(input);
		expect(result.content).toContain('0123456789ABCDEF<a href="https://example.com/a?x=1&amp;y=2">链接</a>尾巴');
		expect(result.content).toContain('<a href="https://example.feishu.cn/docx/linked"><strong>引用文档</strong></a>');
		expect(result.warnings).toEqual([]);
	});

	test('restores every inline document mention when Feishu omits raw placeholders', () => {
		const pool: Record<string, [string, string]> = { '0': ['author', 'someone'] };
		for (let i = 0; i < 5; i++) {
			pool[String(i * 2 + 1)] = ['bold', 'true'];
			pool[String(i * 2 + 2)] = ['inline-component', JSON.stringify({ type: 'mention_doc', data: { title: `推荐${i + 1}`, raw_url: `https://example.feishu.cn/docx/${i + 1}` } })];
		}
		const input = document({ p: { type: 'text', text: text('推荐阅读： ', '*0+5*0*1*2+1*0*3*4+1*0*5*6+1*0*7*8+1*0*9*a+1', pool) } });
		const result = renderFeishuSnapshot(input);
		for (let i = 1; i <= 5; i++) expect(result.content).toContain(`<a href="https://example.feishu.cn/docx/${i}"><strong>推荐${i}</strong></a>`);
		expect(result.content).toContain('推荐阅读：');
		expect(result.warnings).toEqual([]);
	});

	test('does not swallow ordinary text following an omitted inline placeholder', () => {
		const component = JSON.stringify({ type: 'mention_doc', data: { title: '文档', raw_url: 'https://example.com/doc' } });
		const input = document({ p: { type: 'text', text: text('前后', '+1*0+1+1', { '0': ['inline-component', component] }) } });
		const result = renderFeishuSnapshot(input);
		expect(result.content).toBe('<p>前<a href="https://example.com/doc">文档</a>后</p>');
		expect(result.warnings).toEqual([]);
	});

	test('reports unknown rich text schemas and non-string segments', () => {
		const input = document({ unknown: { type: 'text', text: { futureText: '不能静默忽略' } }, segment: { type: 'text', text: { initialAttributedTexts: { text: { '0': { value: '未知片段' } } } } } });
		const result = renderFeishuSnapshot(input);
		expect(result.warnings).toHaveLength(2);
		expect(result.warnings[0]).toContain('文字结构无法识别');
		expect(result.warnings[1]).toContain('不是字符串');
	});

	test('keeps list siblings grouped and nests child lists', () => {
		const input = document({
			a: { type: 'ordered', seq: 'auto', text: text('一'), children: ['nested'] },
			b: { type: 'ordered', text: text('二') }, nested: { type: 'bullet', text: text('子项') },
			end: { type: 'text', text: text('结尾') }
		}, ['a', 'b', 'end']);
		expect(renderFeishuSnapshot(input).content).toBe('<ol><li>一<ul><li>子项</li></ul></li><li>二</li></ol><p>结尾</p>');
	});

	test('reports missing and unsupported blocks without discarding known text or children', () => {
		const input = document({ custom: { type: 'unknown-widget', text: text('组件文字'), children: ['child'] }, child: { type: 'text', text: text('内部文字') } }, ['missing', 'custom']);
		const result = renderFeishuSnapshot(input);
		expect(result.missingIds).toEqual(['missing']);
		expect(result.unsupportedTypes).toEqual(['unknown-widget']);
		expect(result.content).toContain('组件文字');
		expect(result.content).toContain('内部文字');
		expect(result.content).toContain('#missing');
		expect(result.warnings.length).toBe(2);
	});

	test('escapes HTML and never emits unsafe link or image URLs', () => {
		const input = document({ p: { type: 'text', text: text('<script>', '*0+8', { '0': ['link', 'javascript%3Aalert(1)'] }) }, img: { type: 'image', image: { name: '"><script>x</script>' } } });
		input.imageUrls = { img: 'data:text/html,<script>alert(1)</script>' };
		const result = renderFeishuSnapshot(input);
		expect(result.content).not.toContain('<script>');
		expect(result.content).not.toContain('javascript:');
		expect(result.content).not.toContain('<img');
		expect(result.content).toContain('&lt;script&gt;');
		expect(result.warnings.length).toBe(2);
	});

	test('restores synced references from records and warns for DOM-only fallback', () => {
		const input = document({ ref: { type: 'synced_reference', src_block_id: 'source' }, source: { type: 'text', text: text('结构化引用内容') }, fallback: { type: 'synced_reference', src_block_id: 'external' } }, ['ref', 'fallback']);
		input.domByRecordId = { fallback: '<p onclick="bad()">可见 &amp; 文本</p><script>secret()</script>' };
		const result = renderFeishuSnapshot(input);
		expect(result.content).toContain('结构化引用内容');
		expect(result.content).toContain('可见 &amp; 文本');
		expect(result.content).not.toContain('secret()');
		expect(result.content).not.toContain('onclick');
		expect(result.content).toContain('document#fallback');
		expect(result.content).not.toContain('document#external');
		expect(result.warnings).toHaveLength(1);
	});

	test('deduplicates repeated blocks, detects cycles, and terminates', () => {
		const input = document({ p: { type: 'text', text: text('只出现一次'), children: ['root'] } }, ['p', 'p']);
		const result = renderFeishuSnapshot(input);
		expect(result.content.match(/只出现一次/g)).toHaveLength(1);
		expect(result.warnings[0]).toContain('循环引用');
		expect(result.blockCount).toBe(2);
	});

	test('preserves remaining text when attribution data is malformed', () => {
		const input = document({ p: { type: 'text', text: text('完整内容', '*0+2?broken', { '0': ['bold', 'true'] }) } });
		const result = renderFeishuSnapshot(input);
		expect(result.content).toBe('<p><strong>完整</strong>内容</p>');
		expect(result.warnings).not.toHaveLength(0);
	});

	test('renders images only from the supplied URL map and preserves captions', () => {
		const input = document({ image: { type: 'image', image: { name: '截图', caption: { text: text('图片说明') } } } });
		input.imageUrls = { image: 'https://example.feishu.cn/observed/image?width=800' };
		const result = renderFeishuSnapshot(input);
		expect(result.content).toBe('<figure><img src="https://example.feishu.cn/observed/image?width=800" alt="截图"><figcaption>图片说明</figcaption></figure>');
		expect(result.warnings).toEqual([]);
	});

	test('accepts the explicit null/null rich text used by empty Feishu image captions', () => {
		const emptyCaption = { apool: { nextNum: 0, numToAttrib: null }, initialAttributedTexts: { attribs: null, text: null } };
		const input = document({ image: { type: 'image', image: { name: 'image.png', caption: { text: emptyCaption } } } });
		input.imageUrls = { image: 'https://example.feishu.cn/image.png' };
		const result = renderFeishuSnapshot(input);
		expect(result.content).toContain('<img');
		expect(result.content).not.toContain('figcaption');
		expect(result.warnings).toEqual([]);
	});
});
