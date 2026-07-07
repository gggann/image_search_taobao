var MAPI_RESULT_KEY_PREFIX = "tbis_mapi_result_";

init();

async function init() {
  const requestId = new URL(location.href).searchParams.get("requestId") || "";
  const summary = document.getElementById("summary");
  const content = document.getElementById("content");

  if (!requestId) {
    summary.textContent = "缺少 requestId";
    content.innerHTML = `<div class="tbis-mapi-error">没有找到本次 mapi 搜索记录。</div>`;
    return;
  }

  const key = `${MAPI_RESULT_KEY_PREFIX}${requestId}`;
  const data = await chrome.storage.local.get(key);
  const record = data[key];
  if (!record) {
    summary.textContent = "记录不存在或已被清理";
    content.innerHTML = `<div class="tbis-mapi-error">没有找到本次 mapi 搜索记录。</div>`;
    return;
  }

  if (!record.ok) {
    summary.textContent = "mapi 请求失败";
    content.innerHTML = `<div class="tbis-mapi-error">${escapeHtml(record.error || "未知错误")}</div>`;
    return;
  }

  const products = Array.isArray(record.products) ? record.products : [];
  summary.textContent = `返回 ${products.length} 个商品，原始 itemsArray ${record.rawCount || 0} 个`;
  if (!products.length) {
    content.innerHTML = `<div class="tbis-mapi-empty">接口成功返回，但没有解析到商品。</div>`;
    return;
  }

  content.innerHTML = `<div class="tbis-mapi-grid">${products.map(renderProduct).join("")}</div>`;
}

function renderProduct(product) {
  return `
    <a class="tbis-mapi-card" href="${escapeAttr(product.detailUrl)}" target="_blank" rel="noopener">
      <img class="tbis-mapi-image" src="${escapeAttr(product.imageUrl)}" alt="">
      <div class="tbis-mapi-info">
        <div class="tbis-mapi-name">${escapeHtml(product.title)}</div>
        <div class="tbis-mapi-price">${formatPrice(product.price)}</div>
        <div class="tbis-mapi-meta">${escapeHtml([product.sales, product.location, product.shopName].filter(Boolean).join(" · "))}</div>
      </div>
    </a>
  `;
}

function formatPrice(price) {
  if (price == null || price === "") return "价格未知";
  const text = String(price).trim();
  return text.startsWith("¥") ? escapeHtml(text) : `¥${escapeHtml(text)}`;
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
