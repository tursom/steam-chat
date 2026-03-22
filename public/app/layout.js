export function createLayoutController({
  mediaQuery,
  sidebarEl,
  sidebarBackdrop,
  mobileSidebarToggleButton,
  onResponsiveChange,
}) {
  function updateViewportHeightVar() {
    const viewport = window.visualViewport;
    const height = viewport && Number.isFinite(viewport.height)
      ? viewport.height
      : window.innerHeight;
    const offsetTop = viewport && Number.isFinite(viewport.offsetTop)
      ? viewport.offsetTop
      : 0;
    document.documentElement.style.setProperty('--app-height', height + 'px');
    document.documentElement.style.setProperty('--viewport-offset-top', offsetTop + 'px');
  }

  function isMobileLayout() {
    return mediaQuery.matches;
  }

  function setSidebarOpen(open) {
    const shouldOpen = Boolean(open && isMobileLayout());
    sidebarEl.classList.toggle('open', shouldOpen);
    sidebarBackdrop.classList.toggle('open', shouldOpen);
    sidebarBackdrop.setAttribute('aria-hidden', shouldOpen ? 'false' : 'true');
    mobileSidebarToggleButton.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  }

  function closeSidebar() {
    setSidebarOpen(false);
  }

  function toggleSidebar() {
    setSidebarOpen(!sidebarEl.classList.contains('open'));
  }

  function syncResponsiveLayout() {
    if (!isMobileLayout()) {
      closeSidebar();
    }
    onResponsiveChange();
  }

  return {
    closeSidebar,
    isMobileLayout,
    syncResponsiveLayout,
    toggleSidebar,
    updateViewportHeightVar,
  };
}
