export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(async () => {
    await browser.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    await browser.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    await browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  });
});
