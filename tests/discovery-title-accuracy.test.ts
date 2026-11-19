import assert from "node:assert/strict";
import test from "node:test";
import { isOfficialCandidateTitle, mentionsBrand } from "../packages/runtime/dist/site-discovery.js";

/**
 * 真实风格标题的判定回归（#201）。
 *
 * 上一轮 50 家企业用例里的「官网标题」都是理想形态（`XX官方网站`），
 * 掩盖了两类真实问题：
 *   1) 漏判：`潍柴动力股份有限公司官网` 因为「动力」不在后缀表里被判不匹配；
 *   2) 误判：`美的空调经销商_加盟条件`、`小米官网大全`、`TCL电视价格表`
 *      因为品牌后面跟了行业词而通过品牌检查，却没排除经销商/价格/导航类标题。
 * 这组用例把两边的边界都钉住。
 */

/** 真实风格的官网标题：必须接受。 */
const OFFICIAL_TITLES: Array<[string, string]> = [
	["美的集团股份有限公司", "美的"],
	["美的集团官网", "美的"],
	["美的 | 官方网站", "美的"],
	["首页 - 美的", "美的"],
	["美的-Midea官方网站", "美的"],
	["Midea Group 美的集团", "美的"],
	["美的空调官网_美的官网", "美的"],
	["海尔智家官网", "海尔"],
	["海尔集团官网-海尔官网", "海尔"],
	["Haier 海尔官方网站", "海尔"],
	["潍柴动力股份有限公司官网", "潍柴"],
	["潍柴动力-官方网站", "潍柴"],
	["宁德时代新能源科技股份有限公司", "宁德时代"],
	["比亚迪汽车官网", "比亚迪"],
	["三一重工官方网站", "三一重工"],
	["TCL集团官网", "TCL"],
	["京东方科技集团股份有限公司", "京东方"],
	["科大讯飞-用人工智能建设美好世界", "科大讯飞"],
	["安踏官方网站", "安踏"],
	["波司登官网-羽绒服", "波司登"],
	["小米官网-小米手机", "小米"],
	["华为技术有限公司", "华为"],
	["蒙牛乳业官网", "蒙牛"],
	["海天味业官方网站", "海天味业"],
	["光明乳业股份有限公司", "光明乳业"],
	["徐工集团官网", "徐工"],
	["中联重科股份有限公司", "中联重科"],
	["立讯精密工业股份有限公司", "立讯精密"],
	["用友网络科技股份有限公司", "用友"],
	["良品铺子官方网站", "良品铺子"],
];

/** 真实风格的干扰标题：必须拒绝。 */
const IMPOSTOR_TITLES: Array<[string, string]> = [
	["美的空调经销商_加盟条件", "美的"],
	["美的集团招聘信息", "美的"],
	["美的吧_百度贴吧", "美的"],
	["美的空调官网价格表", "美的"],
	["美的商城旗舰店-天猫", "美的"],
	["美的官方网站导航大全", "美的"],
	["真美的画面", "美的"],
	["海尔曼工业集团", "海尔"],
	["海尔纽约人寿保险", "海尔"],
	["海尔的冰箱怎么样", "海尔"],
	["潍柴动力股票行情", "潍柴"],
	["宁德时代吧_讨论区", "宁德时代"],
	["比亚迪招聘官网", "比亚迪"],
	["三一重工经销商查询", "三一重工"],
	["TCL电视价格表", "TCL"],
	["京东方是什么", "京东方"],
	["科大讯飞股票", "科大讯飞"],
	["安踏专卖店加盟", "安踏"],
	["波司登羽绒服批发", "波司登"],
	["小米官网大全", "小米"],
	["华为招聘", "华为"],
	["蒙牛乳业供应商招募", "蒙牛"],
	["徐工二手机交易市场", "徐工"],
	["中联重科招标公告", "中联重科"],
	["立讯精密股价", "立讯精密"],
	["良品铺子加盟费多少", "良品铺子"],
];

test("真实风格官网标题全部接受（不漏判）", () => {
	const missed = OFFICIAL_TITLES
		.filter(([title, brand]) => !isOfficialCandidateTitle(title, brand))
		.map(([title, brand]) => `${brand} | ${title}`);
	assert.deepEqual(missed, [], `漏判 ${missed.length} 条`);
});

test("真实风格干扰标题全部拒绝（不误判成官网）", () => {
	const wrong = IMPOSTOR_TITLES
		.filter(([title, brand]) => isOfficialCandidateTitle(title, brand))
		.map(([title, brand]) => `${brand} | ${title}`);
	assert.deepEqual(wrong, [], `误判 ${wrong.length} 条`);
});

test("品牌边界：中文短品牌不匹配更长词，拉丁品牌按词边界", () => {
	assert.equal(mentionsBrand("海尔智家", "海尔"), true);
	assert.equal(mentionsBrand("海尔曼工业集团", "海尔"), false);
	assert.equal(mentionsBrand("美的很安静", "美的"), false);
	assert.equal(mentionsBrand("Midea Group", "Midea"), true);
	assert.equal(mentionsBrand("Mideas", "Midea"), false);
});

test("干扰标题的排除发生在品牌匹配之前（品牌不出现也拒绝）", () => {
	// 标题里连品牌都没有，但也不能因为其他理由被当成官网。
	assert.equal(isOfficialCandidateTitle("招聘信息-最新岗位", "美的"), false);
	assert.equal(isOfficialCandidateTitle("", "美的"), false);
	// 真正官网标题照常通过。
	assert.equal(isOfficialCandidateTitle("美的集团官网", "美的"), true);
});
