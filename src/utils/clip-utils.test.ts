// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseForClipAsync } from './clip-utils';

const mocks = vi.hoisted(() => ({
	extractFeishuContent: vi.fn(),
	parse: vi.fn(),
	parseAsync: vi.fn(),
}));

vi.mock('./feishu-extractor', () => ({
	extractFeishuContent: mocks.extractFeishuContent,
}));

vi.mock('defuddle/full', () => ({
	default: class {
		constructor(private doc: Document) {}
		parse() { return mocks.parse(this.doc); }
		parseAsync() { return mocks.parseAsync(this.doc); }
	},
}));

function page(html = '<p>Only the visible blocks</p>') {
	const doc = new DOMParser().parseFromString(html, 'text/html');
	Object.defineProperty(doc, 'URL', { value: 'https://example.com/article' });
	return doc;
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.extractFeishuContent.mockResolvedValue(null);
	mocks.parse.mockImplementation((doc: Document) => ({ content: doc.body.innerHTML }));
});

afterEach(() => {
	vi.useRealTimers();
});

describe('shared async clipping extraction', () => {
	it('uses the full Feishu document for every caller, without re-parsing its viewport DOM', async () => {
		const complete = { content: '<h1>Complete document</h1><p>Final block</p>', variables: { blockCount: '3' } };
		mocks.extractFeishuContent.mockResolvedValue(complete);
		expect(await parseForClipAsync(page())).toBe(complete);
		expect(mocks.parse).not.toHaveBeenCalled();
		expect(mocks.parseAsync).not.toHaveBeenCalled();
	});

	it('propagates Feishu failures instead of silently clipping a partial DOM', async () => {
		const failure = new Error('飞书剪藏：文档尚未加载完整，请稍后重试。');
		mocks.extractFeishuContent.mockRejectedValue(failure);
		await expect(parseForClipAsync(page())).rejects.toBe(failure);
		expect(mocks.parse).not.toHaveBeenCalled();
		expect(mocks.parseAsync).not.toHaveBeenCalled();
	});

	it('reuses a reader article before trying to access a removed site editor', async () => {
		const doc = page('<div class="obsidian-reader-active"><div class="obsidian-reader-content"><article><p>Reader controls</p></article></div></div>');
		doc.querySelector('article')!.setAttribute('data-original-html', '<h1>Full title</h1><p>Final block</p>');
		expect((await parseForClipAsync(doc)).content).toBe('<h1>Full title</h1><p>Final block</p>');
		expect(mocks.extractFeishuContent).not.toHaveBeenCalled();
		expect(mocks.parseAsync).not.toHaveBeenCalled();
	});

	it('preserves async metadata on ordinary pages and clears the timeout', async () => {
		vi.useFakeTimers();
		const ordinary = { content: '<p>Article</p>', variables: { transcript: 'Complete transcript' } };
		mocks.parseAsync.mockResolvedValue(ordinary);
		expect(await parseForClipAsync(page())).toBe(ordinary);
		expect(mocks.parse).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('falls back after eight seconds if an ordinary page async parser hangs', async () => {
		vi.useFakeTimers();
		mocks.parseAsync.mockReturnValue(new Promise(() => {}));
		const result = parseForClipAsync(page('<p>Ordinary article</p>'));
		await vi.advanceTimersByTimeAsync(7999);
		expect(mocks.parse).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect((await result).content).toBe('<p>Ordinary article</p>');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('keeps the existing sync fallback for an ordinary page async failure', async () => {
		mocks.parseAsync.mockRejectedValue(new Error('fetch unavailable'));
		expect((await parseForClipAsync(page('<p>Ordinary article</p>'))).content).toBe('<p>Ordinary article</p>');
	});
});
