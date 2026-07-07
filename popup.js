document.getElementById("open-taobao").addEventListener("click", () => {
  chrome.tabs.create({
    url: "https://s.taobao.com/search?imgfile=&js=1&q=&search_type=item&sourceId=tb.index&ie=utf8",
    active: true
  });
});
