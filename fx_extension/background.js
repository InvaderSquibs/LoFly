/**
 * FX extension service worker — open side panel on toolbar click.
 */
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (err) {
    console.warn("FX sidePanel.open", err);
  }
});
