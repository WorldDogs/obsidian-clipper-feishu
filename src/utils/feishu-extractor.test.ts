// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import browser from './browser-polyfill';
import { extractFeishuContent } from './feishu-extractor';
import type { FeishuSnapshot } from './feishu-renderer';

const url = 'https://example.feishu.cn/wiki/document';

function page(address = url): Document {
	const doc = new DOMParser().parseFromString('<p>Visible viewport only</p>', 'text/html');
	Object.defineProperty(doc, 'URL', { value: address });
	return doc;
}

function snapshot(): FeishuSnapshot {
	return {
		url, title: '完整文档', rootId: 'root', records: {
			root: { id: 'root', snapshot: { type: 'page', children: ['first', 'tail'] } },
			first: { id: 'first', snapshot: { type: 'heading1', text: '开始' } },
			tail: { id: 'tail', snapshot: { type: 'text', text: '最后一段' } },
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('Feishu extraction adapter', () => {
	test('leaves ordinary pages to the generic parser without contacting the background', async () => {
		const send = vi.spyOn(browser.runtime, 'sendMessage');
		expect(await extractFeishuContent(page('https://example.com/article'))).toBeNull();
		expect(send).not.toHaveBeenCalled();
	});

	test('returns the complete model content and metadata and clears the request timeout', async () => {
		vi.useFakeTimers();
		const send = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({ snapshot: snapshot() });
		const result = await extractFeishuContent(page());
		expect(send).toHaveBeenCalledWith({ action: 'getFeishuSnapshot', url });
		expect(result?.content).toBe('<h1>开始</h1><p>最后一段</p>');
		expect(result?.title).toBe('完整文档');
		expect(result?.extractorType).toBe('feishu');
		expect(result?.variables).toEqual({ feishuBlockCount: '3', feishuComplete: 'true', feishuWarnings: '' });
		expect(vi.getTimerCount()).toBe(0);
	});

	test('fails closed after 15 seconds instead of returning the visible viewport', async () => {
		vi.useFakeTimers();
		vi.spyOn(browser.runtime, 'sendMessage').mockReturnValue(new Promise(() => {}));
		const result = extractFeishuContent(page());
		const rejection = expect(result).rejects.toThrow('飞书剪藏：提取器未能及时返回');
		await vi.advanceTimersByTimeAsync(14999);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await rejection;
		expect(vi.getTimerCount()).toBe(0);
	});

	test('rejects a missing block rather than exporting a partial document', async () => {
		const data = snapshot();
		delete data.records.tail;
		vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({ snapshot: data });
		await expect(extractFeishuContent(page())).rejects.toThrow('飞书剪藏：还有 1 个文档块未加载');
	});

	test('makes unsupported blocks visible and never marks the result complete', async () => {
		const data = snapshot();
		data.records.tail.snapshot.type = 'unknown-widget';
		vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({ snapshot: data });
		const result = await extractFeishuContent(page());
		expect(result?.content).toContain('<blockquote>剪藏提示：');
		expect(result?.content).toContain('最后一段');
		expect(result?.variables?.feishuComplete).toBe('false');
		expect(result?.variables?.feishuWarnings).toContain('unknown-widget');
		const parsed = new DOMParser().parseFromString(result!.content, 'text/html');
		expect(parsed.body.firstElementChild?.textContent).toBe('剪藏提示：1 处格式或内容需要核对。');
	});

	test('summarizes missing images and references without exposing technical block IDs in the notice', async () => {
		const data = snapshot();
		for (let index = 0; index < 5; index++) {
			const id = `technical-image-id-${index}`;
			data.records.root.snapshot.children.push(id);
			data.records[id] = { id, snapshot: { type: 'image' } };
		}
		for (let index = 0; index < 2; index++) {
			const id = `technical-reference-id-${index}`;
			data.records.root.snapshot.children.push(id);
			data.records[id] = { id, snapshot: { type: 'synced_reference', src_block_id: `unavailable-${index}` } };
		}
		vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({ snapshot: data });
		const result = await extractFeishuContent(page());
		const parsed = new DOMParser().parseFromString(result!.content, 'text/html');
		expect(parsed.body.firstElementChild?.textContent).toBe('剪藏提示：5 张图片尚未取得可用地址；2 处引用未完整恢复，已在对应位置保留原文链接。');
		expect(result?.variables?.feishuWarnings).toContain('technical-image-id-0');
		expect(result?.variables?.feishuWarnings).toContain('technical-reference-id-1');
		expect(result?.variables?.feishuComplete).toBe('false');
	});

	test('counts additional unrecognized content separately from missing media', async () => {
		const data = snapshot();
		data.records.first.snapshot = { type: 'image' };
		data.records.tail.snapshot.type = 'unknown-widget';
		vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({ snapshot: data });
		const result = await extractFeishuContent(page());
		const parsed = new DOMParser().parseFromString(result!.content, 'text/html');
		expect(parsed.body.firstElementChild?.textContent).toBe('剪藏提示：1 张图片尚未取得可用地址，已在对应位置保留原文链接；另有 1 处格式或内容需要核对。');
		expect(result?.variables?.feishuComplete).toBe('false');
	});

	test('turns a renderer exception into an explicit Feishu error', async () => {
		const data = { ...snapshot(), records: null };
		vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({ snapshot: data });
		await expect(extractFeishuContent(page())).rejects.toThrow('飞书剪藏：文档数据格式暂不支持，无法保证内容完整。');
	});

	test('rejects an empty document and an unexpected document URL explicitly', async () => {
		const empty = snapshot();
		empty.records.root.snapshot.children = [];
		const send = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValueOnce({ snapshot: empty });
		await expect(extractFeishuContent(page())).rejects.toThrow('飞书剪藏：文档正文为空或尚未加载');
		send.mockResolvedValueOnce({ snapshot: { ...snapshot(), url: `${url}-different` } });
		await expect(extractFeishuContent(page())).rejects.toThrow('飞书剪藏：文档地址已变化');
	});

	test('preserves actionable background errors and clears timers on connection failure', async () => {
		vi.useFakeTimers();
		const send = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValueOnce({ error: '文档数据尚未就绪' });
		await expect(extractFeishuContent(page())).rejects.toThrow('飞书剪藏：文档数据尚未就绪');
		expect(vi.getTimerCount()).toBe(0);
		send.mockRejectedValueOnce(new Error('Extension context invalidated'));
		await expect(extractFeishuContent(page())).rejects.toThrow('飞书剪藏：');
		expect(vi.getTimerCount()).toBe(0);
	});
});
