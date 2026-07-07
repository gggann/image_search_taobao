var BUTTON_BAR_ID = "tbis-product-button-bar";
var mapiSidebarProducts = [];
var mapiSidebarSort = "default";

if (!window.__TBIS_PRODUCT_SEARCH_LOADED__) {
  window.__TBIS_PRODUCT_SEARCH_LOADED__ = true;
  init();
}

function init() {
  if (document.getElementById(BUTTON_BAR_ID)) return;

  const bar = document.createElement("div");
  bar.id = BUTTON_BAR_ID;
  bar.className = "tbis-product-button-bar";

  bar.appendChild(createSearchButton({
    text: "淘宝搜同款",
    loadingText: "正在打开淘宝...",
    doneText: "已打开淘宝图片搜索页",
    messageType: "TBIS_SEARCH_IMAGE",
    source: "productButton"
  }));
  bar.appendChild(createSearchButton({
    text: "mapi搜同款",
    loadingText: "mapi搜索中...",
    doneText: "已打开mapi结果页",
    messageType: "TBIS_MAPI_SEARCH_IMAGE",
    source: "productMapiButton",
    extraClass: "tbis-product-search-button-mapi",
    displayMode: "sidebar"
  }));

  document.documentElement.appendChild(bar);
}

function createSearchButton(options) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `tbis-product-search-button ${options.extraClass || ""}`.trim();
  button.textContent = options.text;

  button.addEventListener("click", async () => {
    await runImageSearch(button, options);
  });

  return button;
}

async function runImageSearch(button, options) {
  const image = findBestProductImage();
  if (!image) {
    showToast("没有识别到主图，请右键商品图片搜索");
    return;
  }

  button.disabled = true;
  button.textContent = options.loadingText;
  if (options.displayMode === "sidebar") {
    showMapiSidebarLoading();
  }
  try {
    const resp = await chrome.runtime.sendMessage({
      type: options.messageType,
      imageUrl: image,
      pageUrl: location.href,
      title: document.title,
      source: options.source,
      displayMode: options.displayMode || ""
    });
    if (!resp || !resp.ok) throw new Error(resp && resp.error || "打开失败");
    if (options.displayMode === "sidebar") {
      renderMapiSidebar(resp.result && resp.result.record);
    } else {
      showToast(options.doneText);
    }
  } catch (err) {
    if (options.displayMode === "sidebar") {
      renderMapiSidebarError(String(err && err.message || err));
    } else {
      showToast(String(err && err.message || err));
    }
  } finally {
    button.disabled = false;
    button.textContent = options.text;
  }
}

function showMapiSidebarLoading() {
  const sidebar = ensureMapiSidebar();
  sidebar.classList.add("tbis-mapi-sidebar-open");
  sidebar.querySelector(".tbis-mapi-sidebar-summary").textContent = "搜索中...";
  sidebar.querySelector(".tbis-mapi-sidebar-body").innerHTML = `
    <div class="tbis-mapi-sidebar-loading">正在请求淘宝 mapi...</div>
  `;
}

function renderMapiSidebar(record) {
  if (!record || !record.ok) {
    renderMapiSidebarError(record && record.error || "mapi 请求失败");
    return;
  }

  const products = Array.isArray(record.products) ? record.products : [];
  mapiSidebarProducts = products;
  mapiSidebarSort = "default";
  const sidebar = ensureMapiSidebar();
  sidebar.classList.add("tbis-mapi-sidebar-open");
  sidebar.querySelector(".tbis-mapi-sidebar-summary").textContent =
    `返回 ${products.length} 个商品`;
  renderMapiSidebarProducts();
}

function renderMapiSidebarError(message) {
  const sidebar = ensureMapiSidebar();
  sidebar.classList.add("tbis-mapi-sidebar-open");
  sidebar.querySelector(".tbis-mapi-sidebar-summary").textContent = "mapi 请求失败";
  sidebar.querySelector(".tbis-mapi-sidebar-body").innerHTML =
    `<div class="tbis-mapi-sidebar-error">${escapeHtml(message)}</div>`;
}

function ensureMapiSidebar() {
  let sidebar = document.getElementById("tbis-mapi-sidebar");
  if (sidebar) return sidebar;

  sidebar = document.createElement("aside");
  sidebar.id = "tbis-mapi-sidebar";
  sidebar.className = "tbis-mapi-sidebar";
  sidebar.innerHTML = `
    <div class="tbis-mapi-sidebar-header">
      <div>
        <div class="tbis-mapi-sidebar-title">mapi搜同款</div>
        <div class="tbis-mapi-sidebar-summary">准备搜索</div>
      </div>
      <button type="button" class="tbis-mapi-sidebar-close" aria-label="关闭">×</button>
    </div>
    <div class="tbis-mapi-sidebar-sort">
      <button type="button" class="tbis-mapi-sort-button tbis-mapi-sort-active" data-sort="default">基本</button>
      <button type="button" class="tbis-mapi-sort-button" data-sort="price">价格 <span class="tbis-mapi-sort-arrows">◆</span></button>
      <button type="button" class="tbis-mapi-sort-button" data-sort="sales">销量 <span class="tbis-mapi-sort-arrows">◆</span></button>
    </div>
    <div class="tbis-mapi-sidebar-body"></div>
  `;
  sidebar.querySelector(".tbis-mapi-sidebar-close").addEventListener("click", () => {
    sidebar.classList.remove("tbis-mapi-sidebar-open");
  });
  sidebar.querySelector(".tbis-mapi-sidebar-sort").addEventListener("click", (event) => {
    const button = event.target.closest(".tbis-mapi-sort-button");
    if (!button) return;
    mapiSidebarSort = button.dataset.sort || "default";
    renderMapiSidebarProducts();
  });
  document.documentElement.appendChild(sidebar);
  return sidebar;
}

function renderMapiSidebarProducts() {
  const sidebar = ensureMapiSidebar();
  const body = sidebar.querySelector(".tbis-mapi-sidebar-body");
  const products = getSortedMapiProducts();
  updateMapiSortButtons(sidebar);
  body.innerHTML = products.length
    ? `<div class="tbis-mapi-sidebar-grid">${products.map(renderMapiProduct).join("")}</div>`
    : `<div class="tbis-mapi-sidebar-empty">接口成功返回，但没有商品。</div>`;
}

function getSortedMapiProducts() {
  const products = mapiSidebarProducts.slice();
  if (mapiSidebarSort === "price") {
    products.sort((a, b) => parsePrice(a.price) - parsePrice(b.price));
  }
  if (mapiSidebarSort === "sales") {
    products.sort((a, b) => parseSales(b.sales) - parseSales(a.sales));
  }
  return products;
}

function updateMapiSortButtons(sidebar) {
  sidebar.querySelectorAll(".tbis-mapi-sort-button").forEach((button) => {
    button.classList.toggle("tbis-mapi-sort-active", button.dataset.sort === mapiSidebarSort);
  });
}

function renderMapiProduct(product) {
  return `
    <a class="tbis-mapi-sidebar-item" href="${escapeAttr(product.detailUrl)}" target="_blank" rel="noopener">
      <img class="tbis-mapi-sidebar-image" src="${escapeAttr(product.imageUrl)}" alt="">
      <div class="tbis-mapi-sidebar-info">
        <div class="tbis-mapi-sidebar-name">${escapeHtml(product.title)}</div>
        <div class="tbis-mapi-sidebar-price">${formatPrice(product.price)}</div>
        <div class="tbis-mapi-sidebar-meta">${escapeHtml([product.sales, product.location, product.shopName].filter(Boolean).join(" · "))}</div>
      </div>
    </a>
  `;
}

function formatPrice(price) {
  if (price == null || price === "") return "价格未知";
  const text = String(price).trim();
  return text.startsWith("¥") ? escapeHtml(text) : `¥${escapeHtml(text)}`;
}

function parsePrice(price) {
  const value = Number(String(price == null ? "" : price).replace(/[^\d.]/g, ""));
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function parseSales(sales) {
  const text = String(sales || "");
  const match = text.match(/([\d.]+)\s*(万|\+)?/);
  if (!match) return 0;
  const base = Number(match[1]) || 0;
  return match[2] === "万" ? base * 10000 : base;
}

function findBestProductImage() {
  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
  const candidates = Array.from(document.images || [])
    .map((img) => {
      const rect = img.getBoundingClientRect();
      const src = normalizeImageUrl(img.currentSrc || img.src || "");
      const naturalArea = (img.naturalWidth || 0) * (img.naturalHeight || 0);
      const visibleArea = Math.max(0, rect.width) * Math.max(0, rect.height);
      const text = [
        img.alt || "",
        img.id || "",
        String(img.className || ""),
        src
      ].join(" ");
      let score = 0;
      score += Math.min(naturalArea / 10000, 200);
      score += Math.min((visibleArea / viewportArea) * 300, 160);
      if (/360buyimg|jd\.hk|jd\.com/i.test(src)) score += 45;
      if (/alicdn|taobao|tmall/i.test(src)) score += 45;
      if (/sku|product|goods|main|spec|item|jfs|gallery|magnifier|imagezoom|bao\/uploaded|imgextra/i.test(text)) score += 30;
      if (/logo|icon|sprite|avatar|qr|risk|empty|shop|wangwang|tmallred|top\.webp/i.test(text)) score -= 200;
      if (rect.width < 80 || rect.height < 80) score -= 120;
      return { src, score };
    })
    .filter((x) => x.src && /^https?:/i.test(x.src))
    .sort((a, b) => b.score - a.score);

  return candidates[0] && candidates[0].score > 0 ? candidates[0].src : "";
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
    if (/alicdn\.com$/i.test(u.hostname)) {
      u.pathname = u.pathname.replace(/_(\d+x\d+|q\d+|sum)\.[a-z0-9]+(?:_[a-z0-9]+)?$/i, "");
      normalized = u.toString();
    }
  } catch (_) {
    // Ignore invalid URLs.
  }
  return normalized;
}

function showToast(text) {
  const old = document.getElementById("tbis-jd-toast");
  if (old) old.remove();

  const toast = document.createElement("div");
  toast.id = "tbis-jd-toast";
  toast.className = "tbis-jd-toast";
  toast.textContent = text;
  document.documentElement.appendChild(toast);
  setTimeout(() => toast.remove(), 2600);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

