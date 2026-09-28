/** Render the document records already available to an authorized Feishu page. */
export interface FeishuSnapshot {
	url: string;
	title: string;
	rootId: string;
	records: Record<string, { id: string; snapshot: Record<string, any> }>;
	domByRecordId?: Record<string, string>;
	imageUrls?: Record<string, string>;
}

export interface FeishuRenderResult {
	content: string;
	title: string;
	blockCount: number;
	missingIds: string[];
	unsupportedTypes: string[];
	warnings: string[];
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeUrl(value: unknown, base: string, allowMail = false): string | undefined {
	if (typeof value !== 'string' || !value.trim()) return undefined;
	try {
		const url = new URL(value, base);
		if (url.protocol === 'https:' || url.protocol === 'http:' || (allowMail && url.protocol === 'mailto:')) return url.href;
	} catch { /* Invalid URLs are rendered as text. */ }
	return undefined;
}

function decodeAttribute(value: string): string {
	try { return decodeURIComponent(value); } catch { return value; }
}

// This is deliberately a text fallback, not an HTML sanitizer. Never insert the
// supplied page HTML into the output: all resulting text is escaped again.
function domText(html: string): string {
	return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
		.replace(/<\s*br\s*\/?\s*>|<\/\s*(p|div|li|h[1-6])\s*>/gi, '\n')
		.replace(/<[^>]*>/g, '')
		.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
			const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
			if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
			const hex = entity[1].toLowerCase() === 'x';
			const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}).trim();
}

export function renderFeishuSnapshot(input: FeishuSnapshot): FeishuRenderResult {
	const warnings = new Set<string>();
	const missingIds = new Set<string>();
	const unsupportedTypes = new Set<string>();
	const visited = new Set<string>();
	const active = new Set<string>();
	let blockCount = 0;
	const pageUrl = safeUrl(input.url, input.url);
	const sourceLink = (id: string, label: string) => {
		if (!pageUrl) return escapeHtml(label);
		const url = new URL(pageUrl);
		url.hash = id;
		return `<a href="${escapeHtml(url.href)}">${escapeHtml(label)}</a>`;
	};
	const notice = (id: string, label: string) => `<p>${sourceLink(id, label)}</p>`;

	function inlineRun(text: string, attrs: Record<string, string>, id: string): string {
		let html = escapeHtml(text).replace(/\n/g, '<br>');
		let componentLink: string | undefined;
		if (attrs['inline-component']) {
			try {
				const component = JSON.parse(attrs['inline-component']);
				if (component.type === 'mention_doc' && component.data) {
					const title = typeof component.data.title === 'string' ? component.data.title : '';
					componentLink = safeUrl(component.data.raw_url, input.url);
					if (title) html = escapeHtml(title);
					if (!componentLink) warnings.add(`文档引用 ${id} 没有可用链接，已保留标题。`);
				} else {
					warnings.add(`文本块 ${id} 包含尚未支持的内嵌组件。`);
					if (!text.trim()) html = '[未支持的内嵌内容]';
				}
			} catch {
				warnings.add(`文本块 ${id} 的内嵌组件数据无法解析。`);
				if (!text.trim()) html = '[无法解析的内嵌内容]';
			}
		}
		const enabled = (key: string) => attrs[key] === 'true' || attrs[key] === '1';
		if (enabled('code') || enabled('inline-code')) html = `<code>${html}</code>`;
		if (enabled('bold')) html = `<strong>${html}</strong>`;
		if (enabled('italic')) html = `<em>${html}</em>`;
		if (enabled('strikethrough') || enabled('strike')) html = `<s>${html}</s>`;
		if (enabled('underline')) html = `<u>${html}</u>`;
		const link = componentLink ?? (attrs.link ? safeUrl(decodeAttribute(attrs.link), input.url, true) : undefined);
		if (link) html = `<a href="${escapeHtml(link)}">${html}</a>`;
		else if (attrs.link) warnings.add(`文本块 ${id} 的不安全或无效链接已移除。`);
		return html;
	}

	function richText(value: unknown, id: string): string {
		if (typeof value === 'string') return escapeHtml(value).replace(/\n/g, '<br>');
		if (value === undefined || value === null) return '';
		if (typeof value !== 'object') {
			warnings.add(`文本块 ${id} 的文字数据类型无法识别，当前导出可能不完整。`);
			return '';
		}
		const data = value as Record<string, any>;
		const initial = data.initialAttributedTexts;
		// Empty image captions use this explicit null/null representation.
		if (initial && initial.text === null && initial.attribs === null) return '';
		if (!initial || typeof initial.text !== 'object' || !initial.text) {
			if (Object.keys(data).length) warnings.add(`文本块 ${id} 的文字结构无法识别，当前导出可能不完整。`);
			return '';
		}
		const pool = data.apool?.numToAttrib ?? {};
		let result = '';
		for (const key of Object.keys(initial.text)) {
			const text = initial.text[key];
			if (typeof text !== 'string') {
				warnings.add(`文本块 ${id} 的文字片段 ${key} 不是字符串，当前导出可能不完整。`);
				continue;
			}
			const attribution = initial.attribs?.[key];
			if (typeof attribution !== 'string' || !attribution) {
				result += escapeHtml(text).replace(/\n/g, '<br>');
				continue;
			}
			// Etherpad-style operations: zero or more *<base36 attribute id>,
			// optional |<base36 newline count>, then +<base36 UTF-16 length>.
			const operations = /((?:\*[0-9a-z]+)*)(?:\|[0-9a-z]+)?\+([0-9a-z]+)/g;
			let offset = 0;
			let consumed = 0;
			let match: RegExpExecArray | null;
			while ((match = operations.exec(attribution))) {
				if (match.index !== consumed) break;
				consumed = operations.lastIndex;
				const count = parseInt(match[2], 36);
				if (!Number.isSafeInteger(count) || count <= 0) {
					warnings.add(`文本块 ${id} 的格式长度异常，剩余内容已按纯文本保留。`);
					break;
				}
				const attrs: Record<string, string> = Object.create(null);
				for (const token of match[1].split('*').filter(Boolean)) {
					const attribute = pool[String(parseInt(token, 36))];
					if (Array.isArray(attribute) && typeof attribute[0] === 'string' && typeof attribute[1] === 'string') attrs[attribute[0]] = attribute[1];
					else warnings.add(`文本块 ${id} 的部分格式属性缺失，原始文本已保留。`);
				}
				// Feishu's inline components occupy logical attribution positions,
				// but their placeholder characters can be absent from stored text.
				// Restore each component even after the raw string is exhausted; do
				// not consume the following ordinary character as its placeholder.
				if (attrs['inline-component'] && count === 1) {
					const candidate = text.slice(offset, offset + 1);
					const placeholder = /^[ \t\u00a0\u200b\ufffc]$/.test(candidate);
					result += inlineRun(placeholder ? candidate : '', attrs, id);
					if (placeholder) offset++;
				} else {
					if (offset + count > text.length) warnings.add(`文本块 ${id} 的格式长度异常，已保留可用文字和内嵌引用。`);
					result += inlineRun(text.slice(offset, offset + count), attrs, id);
					offset = Math.min(offset + count, text.length);
				}
			}
			if (offset < text.length) result += escapeHtml(text.slice(offset)).replace(/\n/g, '<br>');
			if (consumed !== attribution.length || offset !== text.length) warnings.add(`文本块 ${id} 的部分格式无法解析，原始文本已保留。`);
		}
		return result.replace(/(?:<br>)+$/, '');
	}

	function childrenOf(data: Record<string, any>, id: string): string[] {
		if (data.children === undefined) return [];
		if (!Array.isArray(data.children) || data.children.some((child: unknown) => typeof child !== 'string')) {
			warnings.add(`内容块 ${id} 的子块列表格式异常。`);
			return Array.isArray(data.children) ? data.children.filter((child: unknown): child is string => typeof child === 'string') : [];
		}
		return data.children;
	}

	function renderChildren(ids: string[]): string {
		let html = '';
		let listType = '';
		for (const id of ids) {
			const type = input.records[id]?.snapshot?.type;
			const nextList = type === 'ordered' ? 'ol' : type === 'bullet' ? 'ul' : '';
			if (nextList !== listType) {
				if (listType) html += `</${listType}>`;
				if (nextList) {
					const seq = input.records[id]?.snapshot?.seq;
					const start = nextList === 'ol' && /^\d+$/.test(String(seq)) && Number(seq) > 1 ? ` start="${Number(seq)}"` : '';
					html += `<${nextList}${start}>`;
				}
				listType = nextList;
			}
			html += renderBlock(id);
		}
		if (listType) html += `</${listType}>`;
		return html;
	}

	function renderBlock(id: string): string {
		if (active.has(id)) {
			warnings.add(`内容块 ${id} 出现循环引用，已停止重复遍历。`);
			return notice(id, '[循环引用：请查看原文]');
		}
		if (visited.has(id)) return '';
		if (active.size >= 512) {
			warnings.add(`内容块 ${id} 的嵌套层数过深，已保留原文位置。`);
			return notice(id, '[嵌套内容未展开：请查看原文]');
		}
		visited.add(id);
		const record = input.records[id];
		if (!record || !record.snapshot || typeof record.snapshot !== 'object') {
			missingIds.add(id);
			warnings.add(`内容块 ${id} 尚未加载，当前导出不完整。`);
			return notice(id, '[未加载的内容：请查看原文]');
		}
		active.add(id);
		blockCount++;
		const data = record.snapshot;
		const type = typeof data.type === 'string' ? data.type : 'unknown';
		const text = richText(data.text, id);
		let content = '';
		try {
			const children = renderChildren(childrenOf(data, id));
			if (type === 'page') content = children;
			else if (type === 'text') content = `<p>${text}</p>${children}`;
			else if (/^heading[1-9]$/.test(type)) {
				const level = Math.min(Number(type.slice(7)), 6);
				content = `<h${level}>${text}</h${level}>${children}`;
			} else if (type === 'ordered' || type === 'bullet') content = `<li>${text}${children}</li>`;
			else if (type === 'quote_container' || type === 'callout') content = `<blockquote>${text ? `<p>${text}</p>` : ''}${children}</blockquote>`;
			else if (type === 'divider') content = `<hr>${children}`;
			else if (type === 'image') {
				const imageUrl = safeUrl(input.imageUrls?.[id], input.url);
				const image = data.image && typeof data.image === 'object' ? data.image : data;
				const caption = richText(image.caption?.text ?? image.caption, id);
				const name = typeof image.name === 'string' ? image.name : '飞书图片';
				if (imageUrl) content = `<figure><img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(name)}">${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>${children}`;
				else {
					warnings.add(`图片块 ${id} 没有可用图片地址，已保留原文位置。`);
					content = notice(id, `[图片：${name}，请查看原文]`) + (caption ? `<p>${caption}</p>` : '') + children;
				}
			} else if (type === 'synced_reference') {
				const source = typeof data.src_block_id === 'string' ? data.src_block_id : '';
				if (source && input.records[source] && !visited.has(source)) content = renderBlock(source) + children;
				else {
					const fallback = input.domByRecordId?.[id];
					if (fallback) content = `<p>${escapeHtml(domText(fallback)).replace(/\n/g, '<br>')}</p>`;
					// The source block can belong to another document. Link to the
					// visible reference in this document, not an invalid local source ID.
					content += notice(id, '[引用内容：请查看原文]') + children;
					warnings.add(`引用块 ${id} 未能从完整结构恢复，已保留${fallback ? '当前可见文本及' : ''}原文位置。`);
				}
			} else {
				unsupportedTypes.add(type);
				warnings.add(`内容块 ${id} 的类型 ${type} 尚未完整支持，已保留可用文本、子块和原文位置。`);
				const fallback = text || (input.domByRecordId?.[id] ? escapeHtml(domText(input.domByRecordId[id])).replace(/\n/g, '<br>') : '');
				content = (fallback ? `<p>${fallback}</p>` : '') + children + notice(id, `[${type} 内容：请查看原文]`);
			}
		} finally { active.delete(id); }
		return content;
	}

	const content = renderBlock(input.rootId);
	return { content, title: input.title, blockCount, missingIds: [...missingIds], unsupportedTypes: [...unsupportedTypes], warnings: [...warnings] };
}
