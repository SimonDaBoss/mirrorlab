import { expect, type Page } from "@playwright/test";

export async function controlsFor(mirror: Page): Promise<Page> {
  await expect.poll(() => mirror.context().pages().some(p => p.url().includes("controls.html"))).toBe(true);
  const controls = mirror.context().pages().find(p => p.url().includes("controls.html"))!;
  await expect(controls.locator("#toolbar")).toBeVisible();
  await expect(mirror.locator("#toolbar, #panel, #toast")).toHaveCount(0);
  return controls;
}
