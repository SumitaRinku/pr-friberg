(function (root) {
  "use strict";

  const CODES = {
    "阿根廷":"AR", "阿塞拜疆":"AZ", "爱沙尼亚":"EE", "澳大利亚":"AU", "巴西":"BR",
    "白俄罗斯":"BY", "保加利亚":"BG", "北马其顿":"MK", "比利时":"BE", "冰岛":"IS",
    "波兰":"PL", "波斯尼亚和黑塞哥维那":"BA", "丹麦":"DK", "德国":"DE", "俄罗斯":"RU",
    "法国":"FR", "芬兰":"FI", "格鲁吉亚":"GE", "哈萨克斯坦":"KZ", "荷兰":"NL",
    "黑山":"ME", "加拿大":"CA", "捷克":"CZ", "科索沃":"XK", "克罗地亚":"HR",
    "拉脱维亚":"LV", "黎巴嫩":"LB", "立陶宛":"LT", "卢森堡":"LU", "罗马尼亚":"RO",
    "马来西亚":"MY", "美国":"US", "蒙古":"MN", "南非":"ZA", "挪威":"NO",
    "葡萄牙":"PT", "瑞典":"SE", "瑞士":"CH", "塞尔维亚":"RS", "斯洛伐克":"SK",
    "台湾":"CN", "中国台湾":"CN", "中國台灣":"CN", "土耳其":"TR", "危地马拉":"GT",
    "乌克兰":"UA", "乌拉圭":"UY", "乌兹别克斯坦":"UZ", "西班牙":"ES", "新西兰":"NZ",
    "匈牙利":"HU", "伊拉克":"IQ", "以色列":"IL", "印度":"IN", "印度尼西亚":"ID",
    "英国":"GB", "约旦":"JO", "智利":"CL", "中国":"CN", "中国香港特别行政区":"HK"
  };

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, function (character) {
      return ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[character];
    });
  }

  function countryCode(country) {
    const value = String(country || "").trim();
    if (/^(taiwan|taipei)$/i.test(value)) return "CN";
    return CODES[value] || null;
  }

  function flag(country, className) {
    const label = String(country || "未知国家").trim() || "未知国家";
    const code = countryCode(label);
    const classes = className ? "country-flag " + className : "country-flag";
    if (!code) return '<span class="' + classes + ' country-flag-unknown" role="img" aria-label="' + escapeHtml(label) + '" title="' + escapeHtml(label) + '">?</span>';
    return '<span class="' + classes + '" role="img" aria-label="' + escapeHtml(label) + '" title="' + escapeHtml(label) + '"><img src="https://flagcdn.com/w80/' + code.toLowerCase() + '.png" alt="" width="80" height="60" loading="lazy" decoding="async"></span>';
  }

  root.CS2Flags = { countryCode:countryCode, flag:flag };
})(typeof window !== "undefined" ? window : globalThis);
