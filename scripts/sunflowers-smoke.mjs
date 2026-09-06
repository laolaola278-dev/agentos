import { chromium, expect } from "@playwright/test";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

// Run against a running Next.js instance. Uses a fresh browser profile, never a personal album.
const baseURL = process.env.SUNFLOWERS_URL || "http://localhost:3000";
const output = path.resolve(".next/sunflowers-check");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: process.env.SUNFLOWERS_BROWSER || "chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.setDefaultTimeout(30000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if (message.type() === "error" && /THREE|WebGL|shader|hydration/i.test(message.text())) errors.push(message.text()); });
const shot = name => page.screenshot({ path: path.join(output, `${name}.png`), timeout: 60000 });
const mapPosition = () => page.locator(".sf-world-map > g").last().getAttribute("transform");

try {
  await page.goto(`${baseURL}/sunflowers`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "走进画中", exact: true })).toBeEnabled({ timeout: 60000 });
  await expect(page.locator(".sf-loading")).toHaveCount(0);
  await shot("01-arrival");
  console.log("PASS: world loads and WebGL renders");

  await page.getByRole("button", { name: "走进画中", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("m");
  await expect(page.getByRole("dialog")).toBeVisible();
  const before = await mapPosition();
  await page.getByRole("button", { name: "关闭面板" }).click();
  await page.keyboard.down("w");
  await page.waitForTimeout(1600); // Hold a real movement key for a known duration.
  await page.keyboard.up("w");
  await page.keyboard.press("m");
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await mapPosition()).not.toBe(before);
  await shot("02-world-map");
  console.log("PASS: WASD changes the player position");

  for (const name of ["向日葵之心", "阿尔勒的黄房子", "倒映的天空", "金色远丘"]) {
    await page.getByRole("button", { name: `查看${name}`, exact: true }).click();
    await page.getByRole("button", { name: "前往这里" }).click();
    await expect(page.locator(".sf-location strong")).toHaveText(name);
    if (name === "金色远丘") await shot("03-overlook");
    await page.keyboard.press("m");
    await expect(page.getByRole("dialog")).toBeVisible();
  }
  await page.getByRole("button", { name: "关闭面板" }).click();
  await expect(page.locator(".sf-location-count")).toContainText("04 / 04");
  console.log("PASS: all four landmarks are reachable and discovered");

  await page.keyboard.press("c");
  await expect(page.locator(".sf-camera-ui")).toBeVisible();
  const focal = page.getByRole("slider", { name: "相机焦距" });
  await focal.focus(); await page.keyboard.press("End");
  await expect(focal).toHaveValue("85");
  await page.getByRole("button", { name: "拍摄照片", exact: true }).click();
  await expect(page.getByRole("button", { name: "拍摄照片", exact: true })).toBeEnabled();
  await shot("04-camera");
  await page.getByRole("button", { name: "旅途相册", exact: false }).click();
  await expect(page.locator(".sf-photo-card")).toHaveCount(1);
  const photoURL = await page.locator(".sf-photo-open img").getAttribute("src");
  expect(photoURL.startsWith("data:image/jpeg;base64,")).toBe(true);
  expect(photoURL.length).toBeGreaterThan(10000);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: /下载.*的照片/ }).click();
  const download = await downloadPromise;
  const downloadPath = path.join(output, download.suggestedFilename());
  await download.saveAs(downloadPath);
  expect((await stat(downloadPath)).size).toBeGreaterThan(8000);
  await shot("05-album");
  console.log("PASS: focal length, shutter, real JPEG capture, album and download");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "走进画中", exact: true })).toBeEnabled({ timeout: 60000 });
  await page.getByRole("button", { name: "旅途相册", exact: false }).click();
  await expect(page.locator(".sf-photo-card")).toHaveCount(1);
  expect(await page.locator(".sf-photo-open img").getAttribute("src")).toBe(photoURL);
  await page.getByRole("button", { name: /删除.*的照片/ }).click();
  await expect(page.locator(".sf-photo-card")).toHaveCount(0);
  await page.getByRole("button", { name: "关闭面板" }).click();
  await page.getByRole("button", { name: "开启环境声音" }).click();
  await expect(page.getByRole("button", { name: "关闭环境声音" })).toBeVisible();
  await page.getByRole("button", { name: "关闭环境声音" }).click();
  await page.getByRole("button", { name: "操作指南" }).click();
  await expect(page.getByRole("dialog")).toContainText("自由行走");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  console.log("PASS: album survives reload, delete works, audio and help toggle");

  // Emulate touch in a separate context so coarse-pointer controls are exercised.
  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const touch = await touchContext.newPage();
  touch.on("pageerror", error => errors.push(error.message));
  await touch.goto(`${baseURL}/sunflowers`, { waitUntil: "domcontentloaded" });
  await expect(touch.getByRole("button", { name: "走进画中", exact: true })).toBeEnabled({ timeout: 60000 });
  expect(await touch.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await touch.screenshot({ path: path.join(output, "06-mobile.png"), timeout: 60000 });
  await touch.getByRole("button", { name: "走进画中", exact: true }).tap();
  await expect(touch.getByRole("button", { name: "前进", exact: true })).toBeVisible();
  await touch.getByRole("button", { name: "世界地图", exact: false }).tap();
  const touchBefore = await touch.locator(".sf-world-map > g").last().getAttribute("transform");
  await touch.getByRole("button", { name: "关闭面板" }).tap();
  const forward = touch.getByRole("button", { name: "前进", exact: true });
  const bounds = await forward.boundingBox();
  const client = await touchContext.newCDPSession(touch);
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }] });
  await touch.waitForTimeout(1600);
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await touch.getByRole("button", { name: "世界地图", exact: false }).tap();
  expect(await touch.locator(".sf-world-map > g").last().getAttribute("transform")).not.toBe(touchBefore);
  await touchContext.close();
  console.log("PASS: mobile layout and touch movement");
  expect(errors).toEqual([]);
  console.log(`All sunflower smoke checks passed. Screenshots: ${output}`);
} finally {
  await browser.close();
}
