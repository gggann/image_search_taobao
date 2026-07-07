const MENU_ID = "tbis-search-image";
const STORAGE_KEY = "tbis_pending_upload";
const MAPI_RESULT_KEY_PREFIX = "tbis_mapi_result_";
const DEFAULT_SEARCH_URL =
  "https://s.taobao.com/search?imgfile=&js=1&q=&search_type=item&sourceId=tb.index&ie=utf8";
const MAPI_API_URL =
  "https://h5api.m.taobao.com/h5/mtop.relationrecommend.wirelessrecommend.recommend/2.0/";
const MAPI_APP_KEY = "12574478";
const MAPI_DNR_RULE_ID = 6401;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "用淘宝以图搜同款",
      contexts: ["image"]
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const imageUrl = normalizeImageUrl(info.srcUrl || info.linkUrl || "");
  if (!imageUrl) return;
  startImageSearch({
    imageUrl,
    pageUrl: tab && tab.url,
    title: tab && tab.title,
    source: "contextMenu"
  }).catch((err) => {
    console.warn("[tbis] context menu search failed", err);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !["TBIS_SEARCH_IMAGE", "TBIS_MAPI_SEARCH_IMAGE"].includes(message.type)) return false;

  const payload = {
    imageUrl: normalizeImageUrl(message.imageUrl || ""),
    pageUrl: message.pageUrl || (sender.tab && sender.tab.url),
    title: message.title || (sender.tab && sender.tab.title),
    source: message.source || "content",
    displayMode: message.displayMode || ""
  };
  const action = message.type === "TBIS_MAPI_SEARCH_IMAGE" ? startMapiImageSearch : startImageSearch;

  action(payload)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));

  return true;
});

async function startImageSearch(payload) {
  if (!payload.imageUrl) {
    throw new Error("没有找到可用于搜索的图片");
  }

  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const prepared = await prepareImagePayload(payload.imageUrl);
  const pending = {
    requestId,
    imageUrl: payload.imageUrl,
    pageUrl: payload.pageUrl || "",
    title: payload.title || "",
    source: payload.source || "",
    createdAt: Date.now(),
    ...prepared
  };

  await chrome.storage.local.set({ [STORAGE_KEY]: pending });
  const tab = await chrome.tabs.create({ url: DEFAULT_SEARCH_URL, active: true });

  chrome.tabs.onUpdated.addListener(function listener(tabId, changeInfo) {
    if (tabId !== tab.id) return;
    if (changeInfo.status !== "complete") return;
    chrome.tabs.onUpdated.removeListener(listener);
    chrome.tabs.sendMessage(tab.id, { type: "TBIS_UPLOAD_IMAGE", requestId }).catch(() => {});
  });

  return { tabId: tab.id, requestId, searchUrl: DEFAULT_SEARCH_URL };
}

async function startMapiImageSearch(payload) {
  if (!payload.imageUrl) {
    throw new Error("没有找到可用于搜索的图片");
  }

  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let record;
  try {
    const prepared = await prepareImagePayload(payload.imageUrl);
    if (prepared.mode !== "dataUrl" || !prepared.dataUrl) {
      throw new Error(prepared.fetchError || "图片下载失败");
    }

    const dataUrl = await resizeImageForTaobaoMapi(prepared.dataUrl);
    const result = await searchTaobaoMapi(dataUrl);
    record = {
      ok: true,
      requestId,
      imageUrl: payload.imageUrl,
      pageUrl: payload.pageUrl || "",
      title: payload.title || "",
      source: payload.source || "",
      createdAt: Date.now(),
      ...result
    };
  } catch (err) {
    record = {
      ok: false,
      requestId,
      imageUrl: payload.imageUrl,
      pageUrl: payload.pageUrl || "",
      title: payload.title || "",
      source: payload.source || "",
      createdAt: Date.now(),
      error: String(err && err.message || err)
    };
  }

  await chrome.storage.local.set({ [`${MAPI_RESULT_KEY_PREFIX}${requestId}`]: record });
  if (payload.displayMode === "sidebar") {
    return {
      requestId,
      ok: record.ok,
      record
    };
  }

  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL(`mapi_results.html?requestId=${encodeURIComponent(requestId)}`),
    active: true
  });

  return { tabId: tab.id, requestId, ok: record.ok };
}

async function searchTaobaoMapi(dataUrl) {
  let cookies = await getTaobaoCookies();
  let tokenCookie = cookies.find((cookie) => cookie.name === "_m_h5_tk");
  if (!tokenCookie || !tokenCookie.value) {
    await warmupTaobaoMtopToken();
    cookies = await getTaobaoCookies();
    tokenCookie = cookies.find((cookie) => cookie.name === "_m_h5_tk");
  }
  if (!tokenCookie || !tokenCookie.value) {
    throw new Error("缺少淘宝 _m_h5_tk cookie。请确认当前浏览器已登录淘宝，然后打开一次 https://s.taobao.com/search 后重试。");
  }

  const token = decodeURIComponent(tokenCookie.value).split("_")[0];
  const cookieHeader = tokenCookie.partitionKey
    ? cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join(";")
    : "";
  const timestamp = `${Date.now()}`;
  const pcSecurity = await createTaobaoPcSecuritySign({
    pageFrom: "a21n57.imgsearch",
    imgFrom: "upload"
  });
  const body = buildMapiBody(dataUrl, pcSecurity);
  body.params = JSON.stringify(body.params);
  const bodyText = JSON.stringify(body);
  const sign = md5(`${token}&${timestamp}&${MAPI_APP_KEY}&${bodyText}`);
  const url = `${MAPI_API_URL}?${new URLSearchParams({
    jsv: "2.7.4",
    appKey: MAPI_APP_KEY,
    t: timestamp,
    sign,
    api: "mtop.relationrecommend.wirelessrecommend.recommend",
    v: "2.0",
    timeout: "10000",
    type: "originaljson",
    dataType: "jsonp"
  }).toString()}`;

  await setMapiRequestHeaders(cookieHeader);
  try {
    const resp = await fetch(url, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json"
      },
      body: new URLSearchParams({ data: bodyText }).toString()
    });
    const text = await resp.text();
    const json = parseMtopResponse(text);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
    const items = getMapiItems(json);
    assertMapiSuccess(json, text, items);
    if (!Array.isArray(items)) {
      const ret = Array.isArray(json && json.ret) ? json.ret.join("; ") : "";
      throw new Error(ret || json && json.msg || text.slice(0, 300) || "mapi 未返回商品列表");
    }

    return {
      products: normalizeMapiProducts(items),
      rawCount: items.length,
      ret: json.ret || [],
      apiStatus: json.status || "",
      searchUrl: "https://s.taobao.com/search"
    };
  } finally {
    await clearMapiRequestHeaders();
  }
}

function buildMapiBody(dataUrl, pcSecurity) {
  return {
    appId: "46006",
    params: {
      m: "pc_picture_search",
      device: "HMA-AL00",
      isBeta: "false",
      grayHair: "false",
      from: "nt_history",
      brand: "HUAWEI",
      info: "wifi",
      index: "4",
      rainbow: "",
      schemaType: "auction",
      elderHome: "false",
      isEnterSrpSearch: "true",
      newSearch: "false",
      network: "wifi",
      subtype: "",
      hasPreposeFilter: "false",
      prepositionVersion: "v2",
      client_os: "Android",
      gpsEnabled: "false",
      searchDoorFrom: "srp",
      debug_rerankNewOpenCard: "false",
      homePageVersion: "v7",
      searchElderHomeOpen: "false",
      search_action: "initiative",
      sugg: "_4_1",
      sversion: "13.6",
      style: "list",
      ttid: "1@tbwang_mac_1.0.0#pc",
      needTabs: "true",
      areaCode: "CN",
      vm: "nw",
      countryNum: "156",
      page: 1,
      n: 48,
      q: "",
      qSource: "manual",
      pageSource: "a21bo.jianhua/a.201856.dimagesearch",
      myCNA: "",
      tab: "all",
      sort: "_coefp",
      filterTag: "",
      service: "",
      prop: "",
      loc: "",
      start_price: null,
      end_price: null,
      startPrice: null,
      endPrice: null,
      categoryp: "",
      pageSize: 60,
      strimg: stripDataUrlPrefix(dataUrl),
      imgFrom: "upload",
      pageFrom: "a21n57.imgsearch",
      pcSign: pcSecurity.pcSign,
      random: pcSecurity.random,
      timestamp: pcSecurity.timestamp
    }
  };
}

async function resizeImageForTaobaoMapi(dataUrl) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const maxSize = 300;
    const ratio = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * ratio));
    const height = Math.max(1, Math.round(bitmap.height * ratio));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, width, height);
    if (bitmap.close) bitmap.close();
    const resized = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: 0.8
    });
    return blobToDataUrl(resized);
  } catch (err) {
    console.warn("[tbis] resize image for mapi failed, use original image", err);
    return dataUrl;
  }
}

async function createTaobaoPcSecuritySign(baseParams) {
  const random = getRandomBase64(32);
  const timestamp = `${Date.now()}`;
  const payload = {
    ...baseParams,
    random,
    timestamp
  };
  const salt = "6dbd0668a0634ae9badd25d3da236f47";
  const pcSign = await sha256Base64(`${JSON.stringify(payload)}${salt}`);
  return { pcSign, random, timestamp };
}

function getRandomBase64(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes);
}

async function sha256Base64(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToBase64(new Uint8Array(digest));
}

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function normalizeMapiProducts(items) {
  const seen = new Set();
  return items
    .map((item) => {
      const id = item.item_id || item.itemId || item.nid || "";
      if (!id || seen.has(id)) return null;
      seen.add(id);
      return {
        id,
        title: item.title || "",
        detailUrl: normalizeUrl(item.auctionUrl) || `https://item.taobao.com/item.htm?id=${id}`,
        imageUrl: normalizeUrl(item.pic_path || item.picUrl || ""),
        price: item.umpPriceLog && item.umpPriceLog.item_price || item.priceShow && item.priceShow.price || item.priceWap || "",
        sales: item.realSales || "",
        shopName: item.shopInfo && item.shopInfo.title || "",
        shopUrl: normalizeUrl(item.shopInfo && item.shopInfo.url || ""),
        location: item.procity || ""
      };
    })
    .filter(Boolean);
}

async function getTaobaoCookies() {
  const queries = [
    { domain: "taobao.com" },
    { domain: ".taobao.com" },
    { domain: "h5api.m.taobao.com" },
    { domain: "taobao.com", partitionKey: {} },
    { domain: ".taobao.com", partitionKey: {} },
    { domain: "taobao.com", partitionKey: { topLevelSite: "https://taobao.com" } },
    { domain: ".taobao.com", partitionKey: { topLevelSite: "https://taobao.com" } },
    { url: "https://taobao.com" },
    { url: "https://www.taobao.com" },
    { url: "https://s.taobao.com" },
    { url: "https://h5api.m.taobao.com" }
  ];
  const all = [];
  for (const query of queries) {
    const cookies = await getCookies(query);
    all.push(...cookies);
  }

  const unique = new Map();
  for (const cookie of all) {
    if (!/^\.?taobao\.com$/i.test(cookie.domain || "") && !/taobao\.com$/i.test(cookie.domain || "")) continue;
    if (unique.has(cookie.name) && !cookie.partitionKey) continue;
    unique.set(cookie.name, cookie);
  }
  return Array.from(unique.values());
}

async function warmupTaobaoMtopToken() {
  const timestamp = `${Date.now()}`;
  const url = `https://h5api.m.taobao.com/h5/mtop.common.getTimestamp/1.0/?${new URLSearchParams({
    jsv: "2.7.4",
    appKey: MAPI_APP_KEY,
    t: timestamp,
    sign: "",
    api: "mtop.common.getTimestamp",
    v: "1.0",
    type: "originaljson",
    dataType: "jsonp"
  }).toString()}`;

  try {
    await fetch(url, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json"
      },
      body: new URLSearchParams({ data: "{}" }).toString()
    });
  } catch (err) {
    console.warn("[tbis] warmup taobao mtop token failed", err);
  }
  await delay(500);
}

function getCookies(details) {
  return new Promise((resolve, reject) => {
    chrome.cookies.getAll(details, (cookies) => {
      const err = chrome.runtime.lastError;
      if (err && details.partitionKey) resolve([]);
      else if (err) reject(new Error(err.message));
      else resolve(cookies || []);
    });
  });
}

async function setMapiRequestHeaders(cookieHeader) {
  if (!chrome.declarativeNetRequest) return;
  const requestHeaders = [
    { header: "Referer", operation: "set", value: "https://s.taobao.com/search/" },
    { header: "Origin", operation: "set", value: "https://s.taobao.com" }
  ];
  if (cookieHeader) {
    requestHeaders.push({ header: "Cookie", operation: "set", value: cookieHeader });
  }

  await updateDynamicRules({
    removeRuleIds: [MAPI_DNR_RULE_ID],
    addRules: [{
      id: MAPI_DNR_RULE_ID,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders
      },
      condition: {
        regexFilter: "h5api\\.m\\.taobao\\.com/h5/mtop\\.relationrecommend\\.wirelessrecommend\\.recommend/.*",
        resourceTypes: ["xmlhttprequest"],
        initiatorDomains: [chrome.runtime.id]
      }
    }]
  });
}

async function clearMapiRequestHeaders() {
  if (!chrome.declarativeNetRequest) return;
  await updateDynamicRules({ removeRuleIds: [MAPI_DNR_RULE_ID] });
}

function updateDynamicRules(options) {
  return new Promise((resolve, reject) => {
    chrome.declarativeNetRequest.updateDynamicRules(options, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

function parseMtopResponse(text) {
  const trimmed = String(text || "").trim();
  const jsonText = trimmed.startsWith("{")
    ? trimmed
    : trimmed.replace(/^[^(]*\(/, "").replace(/\);?$/, "");
  return JSON.parse(jsonText);
}

function getMapiItems(json) {
  if (json && json.data && Array.isArray(json.data.itemsArray)) {
    return json.data.itemsArray;
  }
  if (json && json.data && json.data.data && Array.isArray(json.data.data.itemsArray)) {
    return json.data.data.itemsArray;
  }
  return null;
}

function assertMapiSuccess(json, text, items) {
  const ret = Array.isArray(json && json.ret) ? json.ret : [];
  const retText = ret.join("; ");
  const punishUrl = json && json.data && json.data.url;
  if (/RGV587|FAIL|ERROR|DENY|ILLEGAL|SESSION_EXPIRED/i.test(retText) || /punish|deny/i.test(punishUrl || "")) {
    throw new Error(`${retText || "mapi 被风控拦截"}${punishUrl ? `\n${punishUrl}` : ""}`);
  }
  if (!Array.isArray(items)) {
    throw new Error(retText || json && json.msg || text.slice(0, 500) || "mapi 未返回商品列表");
  }
}

function stripDataUrlPrefix(dataUrl) {
  return String(dataUrl || "").replace(/^data:[^,]+,/, "");
}

function normalizeUrl(url) {
  if (!url) return "";
  const value = String(url).trim();
  if (value.startsWith("//")) return `https:${value}`;
  if (/^https?:/i.test(value)) return value;
  return "";
}

function md5(value) {
  function rotateLeft(lValue, shiftBits) {
    return (lValue << shiftBits) | (lValue >>> (32 - shiftBits));
  }

  function addUnsigned(x, y) {
    const x4 = x & 0x40000000;
    const y4 = y & 0x40000000;
    const x8 = x & 0x80000000;
    const y8 = y & 0x80000000;
    const result = (x & 0x3fffffff) + (y & 0x3fffffff);
    if (x4 & y4) return result ^ 0x80000000 ^ x8 ^ y8;
    if (x4 | y4) return result & 0x40000000 ? result ^ 0xc0000000 ^ x8 ^ y8 : result ^ 0x40000000 ^ x8 ^ y8;
    return result ^ x8 ^ y8;
  }

  function f(x, y, z) {
    return (x & y) | (~x & z);
  }

  function g(x, y, z) {
    return (x & z) | (y & ~z);
  }

  function h(x, y, z) {
    return x ^ y ^ z;
  }

  function i(x, y, z) {
    return y ^ (x | ~z);
  }

  function ff(a, b, c, d, x, s, ac) {
    return addUnsigned(rotateLeft(addUnsigned(addUnsigned(a, f(b, c, d)), addUnsigned(x, ac)), s), b);
  }

  function gg(a, b, c, d, x, s, ac) {
    return addUnsigned(rotateLeft(addUnsigned(addUnsigned(a, g(b, c, d)), addUnsigned(x, ac)), s), b);
  }

  function hh(a, b, c, d, x, s, ac) {
    return addUnsigned(rotateLeft(addUnsigned(addUnsigned(a, h(b, c, d)), addUnsigned(x, ac)), s), b);
  }

  function ii(a, b, c, d, x, s, ac) {
    return addUnsigned(rotateLeft(addUnsigned(addUnsigned(a, i(b, c, d)), addUnsigned(x, ac)), s), b);
  }

  function toWords(input) {
    const bytes = new TextEncoder().encode(input);
    const wordCount = (((bytes.length + 8) >>> 6) + 1) * 16;
    const words = new Array(wordCount).fill(0);
    for (let idx = 0; idx < bytes.length; idx += 1) {
      words[idx >> 2] |= bytes[idx] << ((idx % 4) * 8);
    }
    words[bytes.length >> 2] |= 0x80 << ((bytes.length % 4) * 8);
    words[wordCount - 2] = bytes.length << 3;
    words[wordCount - 1] = bytes.length >>> 29;
    return words;
  }

  function wordToHex(word) {
    let output = "";
    for (let count = 0; count <= 3; count += 1) {
      output += (`0${(word >>> (count * 8) & 255).toString(16)}`).slice(-2);
    }
    return output;
  }

  const x = toWords(String(value));
  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  for (let k = 0; k < x.length; k += 16) {
    const aa = a;
    const bb = b;
    const cc = c;
    const dd = d;

    a = ff(a, b, c, d, x[k + 0], 7, 0xd76aa478);
    d = ff(d, a, b, c, x[k + 1], 12, 0xe8c7b756);
    c = ff(c, d, a, b, x[k + 2], 17, 0x242070db);
    b = ff(b, c, d, a, x[k + 3], 22, 0xc1bdceee);
    a = ff(a, b, c, d, x[k + 4], 7, 0xf57c0faf);
    d = ff(d, a, b, c, x[k + 5], 12, 0x4787c62a);
    c = ff(c, d, a, b, x[k + 6], 17, 0xa8304613);
    b = ff(b, c, d, a, x[k + 7], 22, 0xfd469501);
    a = ff(a, b, c, d, x[k + 8], 7, 0x698098d8);
    d = ff(d, a, b, c, x[k + 9], 12, 0x8b44f7af);
    c = ff(c, d, a, b, x[k + 10], 17, 0xffff5bb1);
    b = ff(b, c, d, a, x[k + 11], 22, 0x895cd7be);
    a = ff(a, b, c, d, x[k + 12], 7, 0x6b901122);
    d = ff(d, a, b, c, x[k + 13], 12, 0xfd987193);
    c = ff(c, d, a, b, x[k + 14], 17, 0xa679438e);
    b = ff(b, c, d, a, x[k + 15], 22, 0x49b40821);

    a = gg(a, b, c, d, x[k + 1], 5, 0xf61e2562);
    d = gg(d, a, b, c, x[k + 6], 9, 0xc040b340);
    c = gg(c, d, a, b, x[k + 11], 14, 0x265e5a51);
    b = gg(b, c, d, a, x[k + 0], 20, 0xe9b6c7aa);
    a = gg(a, b, c, d, x[k + 5], 5, 0xd62f105d);
    d = gg(d, a, b, c, x[k + 10], 9, 0x02441453);
    c = gg(c, d, a, b, x[k + 15], 14, 0xd8a1e681);
    b = gg(b, c, d, a, x[k + 4], 20, 0xe7d3fbc8);
    a = gg(a, b, c, d, x[k + 9], 5, 0x21e1cde6);
    d = gg(d, a, b, c, x[k + 14], 9, 0xc33707d6);
    c = gg(c, d, a, b, x[k + 3], 14, 0xf4d50d87);
    b = gg(b, c, d, a, x[k + 8], 20, 0x455a14ed);
    a = gg(a, b, c, d, x[k + 13], 5, 0xa9e3e905);
    d = gg(d, a, b, c, x[k + 2], 9, 0xfcefa3f8);
    c = gg(c, d, a, b, x[k + 7], 14, 0x676f02d9);
    b = gg(b, c, d, a, x[k + 12], 20, 0x8d2a4c8a);

    a = hh(a, b, c, d, x[k + 5], 4, 0xfffa3942);
    d = hh(d, a, b, c, x[k + 8], 11, 0x8771f681);
    c = hh(c, d, a, b, x[k + 11], 16, 0x6d9d6122);
    b = hh(b, c, d, a, x[k + 14], 23, 0xfde5380c);
    a = hh(a, b, c, d, x[k + 1], 4, 0xa4beea44);
    d = hh(d, a, b, c, x[k + 4], 11, 0x4bdecfa9);
    c = hh(c, d, a, b, x[k + 7], 16, 0xf6bb4b60);
    b = hh(b, c, d, a, x[k + 10], 23, 0xbebfbc70);
    a = hh(a, b, c, d, x[k + 13], 4, 0x289b7ec6);
    d = hh(d, a, b, c, x[k + 0], 11, 0xeaa127fa);
    c = hh(c, d, a, b, x[k + 3], 16, 0xd4ef3085);
    b = hh(b, c, d, a, x[k + 6], 23, 0x04881d05);
    a = hh(a, b, c, d, x[k + 9], 4, 0xd9d4d039);
    d = hh(d, a, b, c, x[k + 12], 11, 0xe6db99e5);
    c = hh(c, d, a, b, x[k + 15], 16, 0x1fa27cf8);
    b = hh(b, c, d, a, x[k + 2], 23, 0xc4ac5665);

    a = ii(a, b, c, d, x[k + 0], 6, 0xf4292244);
    d = ii(d, a, b, c, x[k + 7], 10, 0x432aff97);
    c = ii(c, d, a, b, x[k + 14], 15, 0xab9423a7);
    b = ii(b, c, d, a, x[k + 5], 21, 0xfc93a039);
    a = ii(a, b, c, d, x[k + 12], 6, 0x655b59c3);
    d = ii(d, a, b, c, x[k + 3], 10, 0x8f0ccc92);
    c = ii(c, d, a, b, x[k + 10], 15, 0xffeff47d);
    b = ii(b, c, d, a, x[k + 1], 21, 0x85845dd1);
    a = ii(a, b, c, d, x[k + 8], 6, 0x6fa87e4f);
    d = ii(d, a, b, c, x[k + 15], 10, 0xfe2ce6e0);
    c = ii(c, d, a, b, x[k + 6], 15, 0xa3014314);
    b = ii(b, c, d, a, x[k + 13], 21, 0x4e0811a1);
    a = ii(a, b, c, d, x[k + 4], 6, 0xf7537e82);
    d = ii(d, a, b, c, x[k + 11], 10, 0xbd3af235);
    c = ii(c, d, a, b, x[k + 2], 15, 0x2ad7d2bb);
    b = ii(b, c, d, a, x[k + 9], 21, 0xeb86d391);

    a = addUnsigned(a, aa);
    b = addUnsigned(b, bb);
    c = addUnsigned(c, cc);
    d = addUnsigned(d, dd);
  }

  return `${wordToHex(a)}${wordToHex(b)}${wordToHex(c)}${wordToHex(d)}`.toLowerCase();
}

async function prepareImagePayload(imageUrl) {
  const tried = [];
  const candidates = Array.from(new Set([normalizeImageUrl(imageUrl), imageUrl].filter(Boolean)));

  for (const url of candidates) {
    try {
      tried.push(url);
      const resp = await fetch(url, { credentials: "include", cache: "no-store" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      if (!blob || !blob.size) throw new Error("图片为空");
      const dataUrl = await blobToDataUrl(blob);
      return {
        mode: "dataUrl",
        dataUrl,
        mimeType: blob.type || guessMimeType(url),
        fileName: guessFileName(url, blob.type)
      };
    } catch (err) {
      console.warn("[tbis] image fetch failed", url, err);
    }
  }

  return {
    mode: "urlOnly",
    dataUrl: "",
    mimeType: "",
    fileName: "",
    fetchError: `图片下载失败，已尝试：${tried.join(", ")}`
  };
}

function normalizeImageUrl(url) {
  if (!url) return "";
  let normalized = String(url).trim();
  if (normalized.startsWith("//")) normalized = `https:${normalized}`;

  try {
    const u = new URL(normalized);
    if (/360buyimg\.com$/i.test(u.hostname) && /\.avif($|\?)/i.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\.avif$/i, "");
      normalized = u.toString();
    }
  } catch (_) {
    // Keep the original URL when it is not parseable.
  }

  return normalized;
}

function guessMimeType(url) {
  const clean = String(url).split("?")[0].toLowerCase();
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".avif")) return "image/avif";
  return "image/jpeg";
}

function guessFileName(url, mimeType) {
  let base = "product-image";
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split("/").filter(Boolean).pop();
    if (last) base = last.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
  } catch (_) {
    // Use default base.
  }

  if (/\.(jpg|jpeg|png|webp|gif|avif)$/i.test(base)) return base;
  const ext = mimeTypeToExt(mimeType);
  return `${base}.${ext}`;
}

function mimeTypeToExt(mimeType) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/avif") return "avif";
  return "jpg";
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
