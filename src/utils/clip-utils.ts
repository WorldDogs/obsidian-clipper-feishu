import Defuddle from 'defuddle/full';
import { setElementHTML } from './dom-utils';
import { extractFeishuContent } from './feishu-extractor';

// Parse document content for clipping. In reader mode, extracts from
// the article's original HTML to avoid reader UI artifacts.
export function parseForClip(doc: Document) {
	const readerArticle = doc.querySelector('.obsidian-reader-active .obsidian-reader-content article');
	if (readerArticle) {
		const readerDoc = doc.implementation.createHTMLDocument();
		const originalHtml = readerArticle.getAttribute('data-original-html');
		if (originalHtml) {
			setElementHTML(readerDoc.body, originalHtml);
		} else {
			readerDoc.body.replaceChildren(
				...Array.from(readerArticle.childNodes).map(n => readerDoc.importNode(n, true))
			);
		}
		return new Defuddle(readerDoc, { url: '' }).parse();
	}
	return new Defuddle(doc, { url: doc.URL }).parse();
}

// All clipping entry points use the same async extraction path. A reader
// article already contains the extracted document, so it takes precedence
// over a site adapter that needs the original page's live data model.
export async function parseForClipAsync(doc: Document) {
	if (doc.querySelector('.obsidian-reader-active .obsidian-reader-content article')) {
		return parseForClip(doc);
	}

	// Keep site-specific failures outside the generic fallback: parsing a
	// virtualized document's visible DOM would silently produce a partial clip.
	const feishuContent = await extractFeishuContent(doc);
	if (feishuContent) return feishuContent;

	const defuddle = new Defuddle(doc, { url: doc.URL });
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const parseTimeout = new Promise<never>((_, reject) => {
			timeout = setTimeout(() => reject(new Error('parseAsync timeout')), 8000);
		});
		return await Promise.race([defuddle.parseAsync(), parseTimeout]);
	} catch {
		return defuddle.parse();
	} finally {
		clearTimeout(timeout);
	}
}
