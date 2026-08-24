chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'bookmark-page',
    title: '收藏到书签',
    contexts: ['page']
  });
  chrome.contextMenus.create({
    id: 'bookmark-link',
    title: '收藏链接到书签',
    contexts: ['link']
  });
  chrome.contextMenus.create({
    id: 'open-manager',
    title: '打开收藏管理',
    contexts: ['action']
  });
  chrome.contextMenus.create({
    id: 'sync-now',
    title: '同步数据',
    contexts: ['action']
  });
  chrome.contextMenus.create({
    id: 'open-options',
    title: '插件设置',
    contexts: ['action']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'open-manager') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('src/manager.html') });
    return;
  }
  if (info.menuItemId === 'open-options') {
    void chrome.runtime.openOptionsPage();
    return;
  }
  if (info.menuItemId === 'sync-now') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('src/manager.html?sync=1') });
    return;
  }
  if (info.menuItemId !== 'bookmark-page' && info.menuItemId !== 'bookmark-link') return;
  const url = info.menuItemId === 'bookmark-link' ? info.linkUrl : tab?.url;
  if (!url || !/^https?:\/\//i.test(url)) return;
  const title = info.menuItemId === 'bookmark-link' ? info.linkUrl : (tab?.title ?? url);
  const params = new URLSearchParams({ url, title: title ?? url });
  if (tab?.favIconUrl) params.set('iconUrl', tab.favIconUrl);
  void chrome.windows.create({
    url: chrome.runtime.getURL(`src/capture.html?${params.toString()}`),
    type: 'popup',
    width: 430,
    height: 460
  });
});
