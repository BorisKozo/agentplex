export function installPreviewNavigation(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Block every page-initiated navigation except reloading the app page itself. Vite's
  // dev client reloads on `full-reload` (which Forge sends when the preload rebuilds,
  // including right after launch); cancelling that reload mid-load left the window empty.
  contents.on('will-navigate', event => {
    if (event.url !== contents.getURL()) event.preventDefault();
  });
  contents.on('will-frame-navigate', event => {
    if (!event.isMainFrame && event.url !== 'about:srcdoc' && event.url !== 'about:blank') event.preventDefault();
  });
}
