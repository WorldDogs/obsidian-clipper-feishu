// @vitest-environment jsdom
import { afterEach, describe, test, expect, vi } from 'vitest';
import { extractPageContent, processHighlights } from './content-extractor';
import { TextHighlightData } from './highlighter';
import browser from './browser-polyfill';

afterEach(() => vi.restoreAllMocks());

describe('Feishu extraction failures', () => {
	test('shows the actionable extraction error without re-injecting the content script', async () => {
		const error = '飞书剪藏：文档尚未加载完整，请稍后重试。';
		const send = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({ success: false, error });
		await expect(extractPageContent(42)).rejects.toThrow(error);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith({ action: 'sendMessageToTab', tabId: 42, message: { action: 'getPageContent' } });
	});

	test('preserves a Feishu error if stale content-script recovery reaches the adapter', async () => {
		const error = '飞书剪藏：请先在浏览器中打开并加载文档。';
		const send = vi.spyOn(browser.runtime, 'sendMessage')
			.mockRejectedValueOnce(new Error('Extension context invalidated'))
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce({ success: false, error });
		await expect(extractPageContent(42)).rejects.toThrow(error);
		expect(send).toHaveBeenNthCalledWith(2, { action: 'forceInjectContentScript', tabId: 42 });
		expect(send).toHaveBeenCalledTimes(3);
	});

	test('still recovers stale content scripts on ordinary pages', async () => {
		const article = { content: '<p>Recovered article</p>', highlights: [] };
		const send = vi.spyOn(browser.runtime, 'sendMessage')
			.mockRejectedValueOnce(new Error('Extension context invalidated'))
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce(article);
		expect(await extractPageContent(42)).toEqual(article);
		expect(send).toHaveBeenCalledTimes(3);
	});
});

// Default settings already use highlighterEnabled + 'highlight-inline', the
// behavior these tests exercise.

function textHighlight(content: string): TextHighlightData {
	// xpath is empty so processing goes straight to the content-based path,
	// matching the common case where the recorded xpath (live/reader DOM)
	// doesn't resolve against the extracted article content.
	return { type: 'text', id: '1', xpath: '', content, startOffset: 0, endOffset: 0 };
}

describe('processHighlights — highlight-inline', () => {
	const article = '<p>A seismic shift is rocking the healthcare industry. Much like Uber once did.</p>';

	test('wraps a whole-paragraph highlight', () => {
		const result = processHighlights(article, [
			textHighlight('<p>A seismic shift is rocking the healthcare industry. Much like Uber once did.</p>'),
		]);
		expect(result).toContain('<mark>A seismic shift is rocking the healthcare industry. Much like Uber once did.</mark>');
	});

	// Regression for #446 / #852: a sentence highlighted within a paragraph was
	// dropped because it never equaled the full paragraph text.
	test('wraps a sentence highlighted within a paragraph', () => {
		const result = processHighlights(article, [
			textHighlight('<p>A seismic shift is rocking the healthcare industry.</p>'),
		]);
		expect(result).toContain('<mark>A seismic shift is rocking the healthcare industry.</mark>');
		expect(result).toContain('Much like Uber once did.');
	});

	// A partial highlight crossing an inline element must still wrap (the range
	// spans nodes, so it uses extractContents rather than surroundContents).
	test('wraps a partial highlight that spans an inline element', () => {
		const withLink = '<p>A <a href="#">seismic</a> shift is rocking the healthcare industry. Much like Uber.</p>';
		const result = processHighlights(withLink, [
			textHighlight('<p>A seismic shift is rocking the healthcare industry.</p>'),
		]);
		const mark = new DOMParser().parseFromString(result, 'text/html').querySelector('mark');
		expect(mark).not.toBeNull();
		expect(mark!.textContent?.replace(/\s+/g, ' ').trim()).toBe('A seismic shift is rocking the healthcare industry.');
		// The link must survive inside the mark, proving the range crossed it.
		expect(mark!.querySelector('a')).not.toBeNull();
	});
});
