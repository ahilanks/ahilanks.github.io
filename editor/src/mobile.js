/* mobile.js — keep the app sized to the VISUAL viewport on touch devices.
 *
 * The layout is a fixed-height app shell (body doesn't scroll; #scrollArea does).
 * On phones the on-screen keyboard shrinks only the *visual* viewport: iOS Safari
 * doesn't resize the layout viewport at all — it pans the page instead, which
 * shoves the topbar off-screen and hides the caret behind the keyboard. (Chrome
 * on Android resizes the layout thanks to interactive-widget=resizes-content in
 * the meta viewport; there this fitter is a harmless no-op.)
 *
 * Fix: whenever the visual viewport changes, size <body> to it and pin the window
 * scroll back to the top. The topbar stays visible, and #scrollArea's bottom edge
 * sits exactly above the keyboard so caret auto-scroll works inside it. */
export function setupMobileViewport() {
  const vv = window.visualViewport
  if (!vv || !matchMedia('(pointer: coarse)').matches) return
  const fit = () => {
    if (vv.scale > 1.01) return // pinch-zoomed: don't fight the user's zoom pan
    document.body.style.height = Math.round(vv.height) + 'px'
    window.scrollTo(0, 0)
  }
  vv.addEventListener('resize', fit)
  vv.addEventListener('scroll', fit)
  fit()
}
