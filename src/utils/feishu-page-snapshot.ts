import type { FeishuSnapshot } from './feishu-renderer';

export function isFeishuDocumentUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && /(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname)
			&& /^\/(wiki|docx|docs)\/[^/]+/.test(url.pathname);
	} catch { return false; }
}

/** Self-contained: Chrome serializes this function into the page's MAIN world.
 * Read only the current document model; no cookies, credentials or remote calls.
 */
export function readFeishuPageSnapshot(expectedUrl: string): { snapshot?: FeishuSnapshot; error?: string } {
	if (location.href !== expectedUrl || !/(^|\.)(feishu\.cn|larksuite\.com)$/.test(location.hostname)) {
		return { error: '文档地址已变化，请重新打开剪藏。' };
	}
	const page = window as any;
	const service = page.PageMain?.editor?.editor?.api?.dataService;
	if (!service?.getRecordMap || !service.rootRecordId) {
		return { error: '文档数据尚未就绪，或当前飞书版本不支持。请等待文档加载完成后重试。' };
	}
	try {
		const map = service.getRecordMap();
		const read = (id: string) => map instanceof Map ? map.get(id) : map[id];
		const records: FeishuSnapshot['records'] = Object.create(null);
		const queue = [String(service.rootRecordId)];
		const visited = new Set<string>();
		while (queue.length) {
			const id = queue.pop()!;
			if (visited.has(id)) continue;
			visited.add(id);
			if (visited.size > 50000) return { error: '文档超过 50,000 个块，请分篇剪藏。' };
			const record = read(id);
			if (!record?.snapshot) continue;
			// Snapshot data is JSON, unlike the live record objects which contain services.
			const data = JSON.parse(JSON.stringify(record.snapshot));
			records[id] = { id, snapshot: data };
			if (Array.isArray(data.children)) queue.push(...data.children.filter((v: unknown) => typeof v === 'string'));
			if (data.type === 'synced_reference' && typeof data.src_block_id === 'string') queue.push(data.src_block_id);
		}
		if (!records[String(service.rootRecordId)]) return { error: '未找到文档根节点，请刷新页面后重试。' };
		const domByRecordId: Record<string, string> = Object.create(null);
		const imageUrls: Record<string, string> = Object.create(null);
		for (const element of Array.from(document.querySelectorAll<HTMLElement>('[data-record-id]'))) {
			const id = element.dataset.recordId!;
			if (!records[id]) continue;
			if (records[id].snapshot.type === 'synced_reference') {
				const copy = element.cloneNode(true) as HTMLElement;
				copy.querySelectorAll('button, script, style, .block-comment, .synced-reference-block-comment').forEach(el => el.remove());
				domByRecordId[id] = copy.innerHTML;
			}
			const img = element.querySelector('img');
			if (records[id].snapshot.type === 'image' && img?.currentSrc?.startsWith('https:')) imageUrls[id] = img.currentSrc;
		}
		return { snapshot: { url: location.href, title: document.title.replace(/\s*[-–]\s*(飞书云文档|Lark Docs).*$/, ''), rootId: String(service.rootRecordId), records, domByRecordId, imageUrls } };
	} catch { return { error: '无法读取当前文档模型，请刷新页面后重试。' }; }
}
