import assert from "node:assert/strict";
import test from "node:test";
import { discoverCompanySite, pickCompanySite } from "../packages/runtime/dist/site-discovery.js";
import type { SourceFetcher } from "../packages/core/dist/index.js";

/**
 * 50 家中国企业的合成用例库（#198）。
 *
 * 说明：企业名是真实公开的中文品牌；**域名全部是 example 占位**，
 * 不是它们的真实官网，也不代表任何真实站点的判定结果。
 * 这里验证的是「给定同样的搜索结果混排，选站与验证逻辑是否稳定选对」，
 * 不验证真实搜索引擎的召回质量（那需要真实密钥，见 PR 说明）。
 */

/** 真实公开的中国品牌名，覆盖家电、消费、制造、能源、互联网等 50 家。 */
const COMPANIES = [
	"美的", "海尔", "格力", "海信", "TCL", "创维", "康佳", "长虹", "九阳", "苏泊尔",
	"老板电器", "方太", "华帝", "万和", "奥克斯", "格兰仕", "小天鹅", "荣事达", "志高", "美菱",
	"潍柴", "三一重工", "徐工", "中联重科", "宁德时代", "比亚迪", "蔚来", "小鹏", "理想汽车", "吉利",
	"浪潮", "联想", "华为", "小米", "京东方", "立讯精密", "歌尔", "大疆", "科大讯飞", "用友",
	"蒙牛", "伊利", "光明乳业", "三只松鼠", "良品铺子", "洽洽", "海天味业", "金龙鱼", "安踏", "波司登",
] as const;

const slug = (index: number) => `c${String(index).padStart(2, "0")}`;

/** 关键词污染型结果：标题里带品牌名，但不是官网。 */
function trapHits(name: string, index: number): Array<{ title: string; url: string }> {
	const s = slug(index);
	return [
		{ title: `${name}是什么意思_${name}的读音_在线词典`, url: `https://cidian-${s}.example/` },
		{ title: `${name}_百度百科`, url: `https://baike.baidu.com/item/${encodeURIComponent(name)}` },
		{ title: `${name}经销商加盟_代理条件_加盟费`, url: `https://dealer-${s}.example/` },
		{ title: `${name}招聘信息-最新岗位`, url: `https://zhaopin.com/company/${s}` },
		{ title: `${name}官方旗舰店-正品低价`, url: `https://mall-${s}.example/` },
		{ title: `${name}集团有限公司`, url: `https://taiwan-${s}.example/` },
	];
}

/** 官方站首页：标题带品牌 + 官网，并有新闻入口。 */
function officialResponses(name: string, index: number): Record<string, { status: number; body: string }> {
	const host = `brand-${slug(index)}-official.example`;
	const origin = `https://${host}`;
	return {
		[`${origin}/`]: {
			status: 200,
			body: `<html><head><title>${name}官方网站</title></head><body><a href="/news/">新闻中心</a><a href="/about/">关于我们</a></body></html>`,
		},
		[`${origin}/news/`]: {
			status: 200,
			body: `<html><body>
				<a href="/news/2026-11-18">${name}发布年度新品 2026年11月18日</a>
				<a href="/news/2026-11-10">${name}完成产业升级 2026年11月10日</a>
				<a href="/news/2026-11-02">${name}获行业奖项 2026年11月2日</a>
			</body></html>`,
		},
		[`${origin}/about/`]: { status: 200, body: `<html><body>关于${name}</body></html>` },
	};
}

/** 干扰站：首页与品牌无关（验证阶段必须被拒），正文提到品牌也不算官网。 */
function trapResponses(index: number): Record<string, { status: number; body: string }> {
	const s = slug(index);
	return {
		[`https://dealer-${s}.example/`]: {
			status: 200,
			body: `<html><head><title>某某商贸有限公司</title></head><body>本公司代理各大家电品牌</body></html>`,
		},
		[`https://taiwan-${s}.example/`]: {
			status: 200,
			body: `<html><head><title>某某貿易股份有限公司</title></head><body>進口貿易</body></html>`,
		},
		[`https://mall-${s}.example/`]: {
			status: 200,
			body: `<html><head><title>正品商城</title></head><body>精选好物</body></html>`,
		},
	};
}

test("50 家企业：排序与验证都选中官方站，不被词典/百科/经销商/电商/台站带走", async () => {
	const failures: string[] = [];
	for (const [index, name] of COMPANIES.entries()) {
		const s = slug(index);
		const officialHost = `brand-${s}-official.example`;
		const hits = [
			...trapHits(name, index),
			{ title: `${name}官方网站`, url: `https://${officialHost}/` },
		];
		const responses = {
			...officialResponses(name, index),
			...trapResponses(index),
			[`https://cidian-${s}.example/`]: { status: 200, body: "<html><title>在线词典</title></html>" },
			[`https://baike.baidu.com/item/${encodeURIComponent(name)}`]: { status: 200, body: "<html><title>百科</title></html>" },
			["https://zhaopin.com/company/" + s]: { status: 200, body: "<html><title>招聘</title></html>" },
		} satisfies Record<string, { status: number; body: string }>;
		const fetcher: SourceFetcher = {
			async fetchText(url: string) {
				const hit = responses[url];
				if (!hit) throw new Error(`unexpected fetch ${url}`);
				return { status: hit.status, bytes: hit.body.length, body: hit.body };
			},
		};

		// 1) 纯排序：官方站必须排第一。
		const ranked = pickCompanySite(hits, name);
		if (ranked?.host !== officialHost) {
			failures.push(`${name}: 排序首选 ${ranked?.host ?? "null"}，应为 ${officialHost}`);
			continue;
		}

		// 2) 完整验证：返回官方站，且不是任何干扰站。
		const site = await discoverCompanySite(name, undefined, {
			fetcher,
			aggregator: {
				async search() {
					return { hits, providers: [], anyQuotaExhausted: false };
				},
			},
		});
		if (site.host !== officialHost)
			failures.push(`${name}: 验证选中 ${site.host}，应为 ${officialHost}`);
	}
	assert.deepEqual(failures, [], `共 ${failures.length} 家未通过`);
});

test("50 家企业：正文提到品牌但标题无关的站，永远不被当成官网", async () => {
	const failures: string[] = [];
	for (const [index, name] of COMPANIES.entries()) {
		const s = slug(index);
		const impostor = `https://impostor-${s}.example/`;
		const fetcher: SourceFetcher = {
			async fetchText(url: string) {
				if (url === impostor)
					return {
						status: 200,
						bytes: 120,
						body: `<html><head><title>某某行业资讯门户</title></head><body>今日关注：${name} 发布新品，${name} 与多家企业签约。</body></html>`,
					};
				return { status: 200, bytes: 60, body: "<html><body><a href=\"/n/1.html\">资讯</a></body></html>" };
			},
		};
		try {
			const site = await discoverCompanySite(name, undefined, {
				fetcher,
				aggregator: {
					async search() {
						return {
							hits: [{ title: `${name} 最新动态`, url: impostor }],
							providers: [],
							anyQuotaExhausted: false,
						};
					},
				},
			});
			failures.push(`${name}: 把资讯门户当成了官网 ${site.host}`);
		} catch {
			// 抛错才是正确结果：找不到可信官网就如实失败。
		}
	}
	assert.deepEqual(failures, [], `共 ${failures.length} 家被误判`);
});
