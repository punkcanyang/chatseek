// A real side panel stays visible beside the active site. The E2E harness opens
// its HTML in a separate tab, so focus it before Puppeteer's paint-dependent
// IntersectionObserver visibility check and mouse input.
export async function clickForeground(page, selector) {
  await page.bringToFront();
  await page.click(selector);
}
