var STORAGE_KEY = "tbis_pending_upload";
var HANDLED_KEY_PREFIX = "tbis_handled_";

if (!window.__TBIS_TAOBAO_LOADED__) {
  window.__TBIS_TAOBAO_LOADED__ = true;

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "TBIS_UPLOAD_IMAGE") return;
    uploadPendingImage(message.requestId);
  });

  setTimeout(() => uploadPendingImage(), 800);
}

async function uploadPendingImage(requestId) {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const pending = data[STORAGE_KEY];
  if (!pending) return;
  if (requestId && pending.requestId !== requestId) return;
  if (sessionStorage.getItem(`${HANDLED_KEY_PREFIX}${pending.requestId}`)) return;
  if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
    await chrome.storage.local.remove(STORAGE_KEY);
    return;
  }

  sessionStorage.setItem(`${HANDLED_KEY_PREFIX}${pending.requestId}`, "1");

  if (pending.mode !== "dataUrl" || !pending.dataUrl) {
    await chrome.storage.local.remove(STORAGE_KEY);
    return;
  }

  const input = await findUploadInputWithRetry();
  if (!input) {
    sessionStorage.removeItem(`${HANDLED_KEY_PREFIX}${pending.requestId}`);
    return;
  }

  try {
    const beforeState = getUploadDialogState();
    input.files = makeFileList(pending);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await chrome.storage.local.remove(STORAGE_KEY);

    const ready = await waitForUploadReady(beforeState);
    if (ready) await clickImageSearchButtonWithRetry();
  } catch (err) {
    sessionStorage.removeItem(`${HANDLED_KEY_PREFIX}${pending.requestId}`);
    console.warn("[tbis] upload image search failed:", err);
  }
}

async function findUploadInputWithRetry() {
  let input = findUploadInput();
  if (input) return input;

  clickPossibleCameraControl();
  await delay(900);
  input = findUploadInput();
  if (input) return input;

  clickPossibleCameraControl();
  await delay(1400);
  return findUploadInput();
}

function findUploadInput() {
  return Array.from(document.querySelectorAll("input[type='file']")).find((input) => {
    const accept = (input.getAttribute("accept") || "").toLowerCase();
    const name = [input.name, input.id, input.className, accept].join(" ").toLowerCase();
    return !accept || accept.includes("image") || /img|image|pic|photo|file/.test(name);
  }) || null;
}

async function waitForUploadReady(beforeState) {
  const startedAt = Date.now();
  let lastSignature = "";
  let stableCount = 0;

  while (Date.now() - startedAt < 15000) {
    await delay(500);
    const state = getUploadDialogState();
    const signature = `${state.previewCount}:${state.completeCount}:${state.maxArea}`;
    stableCount = signature === lastSignature ? stableCount + 1 : 0;
    lastSignature = signature;

    const hasPreview = state.previewCount > Math.max(0, beforeState.previewCount) || state.previewCount > 0;
    const canSearch = !!state.button && isEnabledLike(state.button);
    if (hasPreview && state.completeCount >= state.previewCount && canSearch && stableCount >= 1) {
      return true;
    }
  }

  return false;
}

async function clickImageSearchButtonWithRetry() {
  for (const wait of [300, 600, 1000]) {
    await delay(wait);
    const button = findImageSearchButton();
    if (button && isEnabledLike(button)) {
      button.click();
      return true;
    }
  }
  return false;
}

function getUploadDialogState() {
  const button = findImageSearchButton();
  const root = button ? findLikelyUploadRoot(button) : document.body;
  const images = Array.from(root.querySelectorAll("img")).filter((img) => {
    const rect = img.getBoundingClientRect();
    const style = getComputedStyle(img);
    return rect.width >= 24 &&
      rect.height >= 24 &&
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth &&
      style.visibility !== "hidden" &&
      style.display !== "none";
  });

  const completeImages = images.filter((img) => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0);
  const maxArea = images.reduce((max, img) => {
    const rect = img.getBoundingClientRect();
    return Math.max(max, Math.round(rect.width * rect.height));
  }, 0);

  return {
    button,
    previewCount: images.length,
    completeCount: completeImages.length,
    maxArea
  };
}

function findImageSearchButton() {
  const candidates = Array.from(document.querySelectorAll("button, a, input, div, span"))
    .map((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const text = getElementText(el);
      if (text !== "搜索") return null;
      if (rect.width < 36 || rect.height < 24) return null;
      if (style.visibility === "hidden" || style.display === "none") return null;
      if (!isEnabledLike(el)) return null;

      const parentText = getAncestorText(el);
      let score = 0;
      if (el.tagName === "BUTTON") score += 20;
      if (el.tagName === "INPUT") score += 15;
      if (rect.top > 100) score += 60;
      if (rect.left < window.innerWidth * 0.55) score += 20;
      if (/按图片搜索|图片搜索|上传|搜同款/.test(parentText)) score += 80;
      if (/rgb\(255,\s*(80|85|68|72|89)|#ff/i.test(style.backgroundColor)) score += 15;
      return { el, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return candidates[0] ? candidates[0].el : null;
}

function clickPossibleCameraControl() {
  const selectors = [
    "[title*='图片']",
    "[title*='拍']",
    "[title*='相机']",
    "[aria-label*='图片']",
    "[aria-label*='相机']",
    "[class*='camera']",
    "[class*='image-search']",
    "[class*='imgsearch']",
    "[class*='upload']",
    "[class*='pic']"
  ];
  for (const selector of selectors) {
    const el = Array.from(document.querySelectorAll(selector)).find(isProbablyClickable);
    if (el) {
      el.click();
      return true;
    }
  }
  return false;
}

function findLikelyUploadRoot(button) {
  let cur = button;
  let best = button.parentElement || document.body;
  for (let i = 0; i < 6 && cur; i += 1) {
    const text = String(cur.textContent || "");
    if (/按图片搜索|图片搜索|上传|搜同款/.test(text)) best = cur;
    cur = cur.parentElement;
  }
  return best;
}

function makeFileList(pending) {
  const file = dataUrlToFile(
    pending.dataUrl,
    pending.fileName || "product-image.jpg",
    pending.mimeType || "image/jpeg"
  );
  const dt = new DataTransfer();
  dt.items.add(file);
  return dt.files;
}

function dataUrlToFile(dataUrl, fileName, mimeType) {
  const parts = dataUrl.split(",");
  const header = parts[0] || "";
  const body = parts[1] || "";
  const detected = (header.match(/data:([^;]+)/) || [])[1] || mimeType || "image/jpeg";
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], fileName, { type: detected });
}

function isEnabledLike(el) {
  const className = String(el.className || "");
  const style = getComputedStyle(el);
  return !el.disabled &&
    el.getAttribute("aria-disabled") !== "true" &&
    !/disabled|disable|loading/i.test(className) &&
    style.pointerEvents !== "none" &&
    Number(style.opacity || "1") >= 0.45;
}

function isProbablyClickable(el) {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return rect.width >= 8 &&
    rect.height >= 8 &&
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    !el.closest("[aria-hidden='true']");
}

function getElementText(el) {
  if (el.tagName === "INPUT") {
    return String(el.value || el.getAttribute("aria-label") || "").trim();
  }
  return String(el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
}

function getAncestorText(el) {
  let cur = el;
  let text = "";
  for (let i = 0; i < 4 && cur; i += 1) {
    text += ` ${cur.textContent || ""}`;
    cur = cur.parentElement;
  }
  return text.slice(0, 500);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
