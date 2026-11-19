// 来源线索条目的质量口径：标题是否像新闻标题、地址是否有文章信号。
// 内置来源、用户自加站点与兜底采集共用同一套规则，避免各处口径漂移。

export const MAX_ITEMS = 20;
const MIN_TITLE = 8;
const NAV_NOISE = /^(首页|网站首页|新闻中心|更多|详情|查看更多|更多动态|浏览更多|read more|more|next|prev)$/i;
/**
 * “像不像文章”的信号：只靠长度与导航词过滤不住实测页面（潍柴导航、浪潮产品列）。
 * 强信号：标题带日期（4）、URL 带日期（3）、URL 带 ≥8 位文章 id（2）；
 * 弱信号：.html/.shtml（1）、路径含新闻段（1）。低于阈值的一律不当条目。
 */
const MIN_ARTICLE_SCORE = 2;
const TITLE_DATE = /(?:20\d{2})\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}/u;
const URL_DATE = /(?:^|\D)20\d{2}(?:[-/]?\d{2}){2}(?:\D|$)/u;
const URL_LONG_ID = /\d{8,}/u;
const URL_PAGE_EXT = /\.s?html?$/iu;
const URL_NEWS_SEGMENT = /(?:^|\/)(?:news|xinwen|xwzx|xwtt|press|media|article|story|newsroom)(?:\/|$)/iu;
/** 标题看着像路径/URL（实测 newsroom.json 的条目标题是 /content/…/ifa-2026）。 */
const PATH_SHAPED_TITLE = /^(?:https?:\/\/|\/)/iu;
const SLUG_SHAPED_TITLE = /^[\w./-]+$/u;
/** 纯数字/电话/符号串（实测 400-618-3066 混进了线索）。 */
const NOISE_TITLE = /^[\d\s()+-_.:,\u00b7/]+$/u;

/** 文章信号打分：见 MIN_ARTICLE_SCORE 的说明，0 表示不像文章。 */
export function articleScore(itemUrl: string, title: string): number {
	let path = "";
	try {
		path = new URL(itemUrl).pathname;
	} catch {
		return 0;
	}
	let score = 0;
	if (TITLE_DATE.test(title)) score += 4;
	if (URL_DATE.test(path)) score += 3;
	else if (URL_LONG_ID.test(path)) score += 2;
	if (URL_PAGE_EXT.test(path)) score += 1;
	if (URL_NEWS_SEGMENT.test(path)) score += 1;
	return score;
}

/** 标题本身是否像可读的新闻标题（不含地址形态判断）。 */
export function isListableTitle(title: string): boolean {
	if (title.length < MIN_TITLE || title.length > 200) return false;
	if (NAV_NOISE.test(title)) return false;
	if (!/\p{L}/u.test(title)) return false;
	if (PATH_SHAPED_TITLE.test(title) || SLUG_SHAPED_TITLE.test(title)) return false;
	if (NOISE_TITLE.test(title)) return false;
	return true;
}

/**
 * 条目筛选：标题必须是可读文本，且地址要有文章信号。
 * 导航/产品页的锚文本（电话号、产品名、路径片段）在这里被排除；
 * 一页都被排除时调用方据此换页或如实失败。
 */
export function isListableItem(title: string, itemUrl: string): boolean {
	return isListableTitle(title) && articleScore(itemUrl, title) >= MIN_ARTICLE_SCORE;
}

/** 对已经取到的条目（如渲染读取兜底）套同一套文章规则。 */
export function filterListableItems<
	T extends { itemKey: string; title: string; itemUrl: string },
>(items: T[]): T[] {
	return items
		.filter((item) => isListableItem(item.title, item.itemUrl))
		.sort((a, b) => articleScore(b.itemUrl, b.title) - articleScore(a.itemUrl, a.title))
		.slice(0, MAX_ITEMS);
}
