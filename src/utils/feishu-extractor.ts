import type { DefuddleResponse } from 'defuddle';
import browser from './browser-polyfill';
import { isFeishuDocumentUrl } from './feishu-page-snapshot';
import { renderFeishuSnapshot, FeishuSnapshot } from './feishu-renderer';

export { isFeishuDocumentUrl } from './feishu-page-snapshot';

type SnapshotResponse = { snapshot?: FeishuSnapshot; error?: string };

function summarizeWarnings(warnings: string[]): string {
	const images = warnings.filter(value => value.startsWith('图片块 ') && value.includes('没有可用图片地址')).length;
	const references = warnings.filter(value => value.startsWith('引用块 ') && value.includes('未能从完整结构恢复')).length;
	const other = warnings.length - images - references;
	const linked: string[] = [];
	if (images) linked.push(`${images} 张图片尚未取得可用地址`);
	if (references) linked.push(`${references} 处引用未完整恢复`);
	const summary: string[] = [];
	if (linked.length) summary.push(`${linked.join('；')}，已在对应位置保留原文链接`);
	if (other) summary.push(`${summary.length ? '另有 ' : ''}${other} 处格式或内容需要核对`);
	return `剪藏提示：${summary.join('；')}。`;
}

export async function extractFeishuContent(doc: Document): Promise<DefuddleResponse | null> {
	if (!isFeishuDocumentUrl(doc.URL)) return null;
	const started = Date.now();
	let response: SnapshotResponse;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		response = await Promise.race([
			browser.runtime.sendMessage({ action: 'getFeishuSnapshot', url: doc.URL }) as Promise<SnapshotResponse>,
			new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 15000); }),
		]);
	} catch { throw new Error('飞书剪藏：提取器未能及时返回，请等待文档加载完成后重试。'); }
	finally { clearTimeout(timer); }
	if (!response?.snapshot) throw new Error(`飞书剪藏：${response?.error || '未取得文档数据。'}`);
	if (response.snapshot.url !== doc.URL) throw new Error('飞书剪藏：文档地址已变化，请重新打开剪藏。');
	let result: ReturnType<typeof renderFeishuSnapshot>;
	try { result = renderFeishuSnapshot(response.snapshot); }
	catch { throw new Error('飞书剪藏：文档数据格式暂不支持，无法保证内容完整。'); }
	if (result.missingIds.length) throw new Error(`飞书剪藏：还有 ${result.missingIds.length} 个文档块未加载，暂不能完整剪藏。请稍后重试。`);
	if (!result.content.trim()) throw new Error('飞书剪藏：文档正文为空或尚未加载，请稍后重试。');
	const parsed = new DOMParser().parseFromString(result.content, 'text/html');
	const text = parsed.body.textContent || '';
	const warnings = result.warnings;
	if (warnings.length) {
		const notice = parsed.createElement('blockquote');
		notice.textContent = summarizeWarnings(warnings);
		parsed.body.prepend(notice);
	}
	return {
		content: parsed.body.innerHTML, title: result.title, description: '', author: '', published: '',
		domain: new URL(doc.URL).hostname, favicon: '', image: '', language: 'zh', site: '飞书云文档',
		parseTime: Date.now() - started, schemaOrgData: null,
		wordCount: (text.match(/[\u3400-\u9fff]|[A-Za-z0-9]+/g) || []).length,
		extractorType: 'feishu', metaTags: [],
		variables: { feishuBlockCount: String(result.blockCount), feishuWarnings: warnings.join('；'), feishuComplete: String(warnings.length === 0) },
	};
}
