const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const legacyMarkup = `<aside class="panel"><div class="head"><h1>批量投递</h1></div>
  <div class="tools"><input placeholder="筛选标题、公司、城市"></div>
  <button class="go">投递已勾选</button></aside>`;

test("panel migration, single initialization and isolated styles", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.route("https://www.liepin.com/**", (route) => route.fulfill({
      contentType: "text/html",
      headers: { "Content-Security-Policy": "default-src 'none'; style-src 'none'" },
      body: '<html><body><main>Job list</main><aside class="panel" id="site-panel">Site panel</aside></body></html>',
    }));
    await page.goto("https://www.liepin.com/zhaopin/");
    await page.evaluate((markup) => {
      window.__yjsBatchBooted = true;
      window.testListeners = [];
      window.chrome = {
        storage: { local: {
          get: (defaults) => new Promise((resolve) => setTimeout(() => resolve(defaults), 50)),
          set: async () => {},
        } },
        runtime: { onMessage: { addListener: (fn) => window.testListeners.push(fn) } },
      };
      const old = document.createElement("div");
      old.id = "yjs-batch-host";
      old.attachShadow({ mode: "open" }).innerHTML = markup;
      document.documentElement.append(old);
      const temporary = document.createElement("div");
      temporary.id = "temporary-panel-fix";
      temporary.attachShadow({ mode: "open" }).innerHTML = markup;
      document.documentElement.append(temporary);
      const plain = document.createElement("div");
      plain.id = "legacy-plain";
      plain.innerHTML = markup;
      document.body.append(plain);
    }, legacyMarkup);

    // A second injection races the asynchronous storage read.
    await page.evaluate((script) => { eval(script); eval(script); }, source);
    await page.waitForSelector("#yjs-batch-host .brand");
    assert.equal(await page.locator("#yjs-batch-host").count(), 1);
    assert.equal(await page.locator("#temporary-panel-fix").count(), 0);
    assert.equal(await page.locator("#legacy-plain aside").count(), 0);
    assert.equal(await page.locator("#site-panel").innerText(), "Site panel");
    assert.equal(await page.evaluate(() => window.testListeners.length), 1);
    assert.deepEqual(await page.evaluate(() => {
      const host = document.getElementById("yjs-batch-host");
      const root = host.shadowRoot;
      return {
        sheets: root.adoptedStyleSheets.length,
        lightText: host.textContent,
        brandSize: getComputedStyle(root.querySelector(".brand")).fontSize,
        panelDisplay: getComputedStyle(root.querySelector(".panel")).display,
        launcherDisplay: getComputedStyle(root.querySelector(".launcher")).display,
      };
    }), { sheets: 1, lightText: "", brandSize: "18px", panelDisplay: "flex", launcherDisplay: "none" });

    await page.locator("#yjs-batch-host .ghost").click();
    assert.equal(await page.locator("#yjs-batch-host .panel").isVisible(), false);
    await page.locator("#yjs-batch-host .launcher").click();
    assert.equal(await page.locator("#yjs-batch-host .panel").isVisible(), true);
    await page.evaluate(() => window.testListeners[0]({ type: "YJS_TOGGLE_PANEL" }, {}, () => {}));
    assert.equal(await page.locator("#yjs-batch-host .panel").isVisible(), false);
    await page.evaluate(() => window.testListeners[0]({ type: "YJS_TOGGLE_PANEL" }, {}, () => {}));

    await page.evaluate((markup) => {
      const late = document.createElement("div");
      late.id = "late-legacy";
      late.attachShadow({ mode: "open" }).innerHTML = markup;
      document.body.append(late);
    }, legacyMarkup);
    await page.waitForFunction(() => !document.getElementById("late-legacy"));
    await page.evaluate((script) => eval(script), source);
    assert.equal(await page.evaluate(() => window.testListeners.length), 1);
    assert.equal(await page.locator("#yjs-batch-host").count(), 1);
    assert.equal(await page.locator("#yjs-batch-host .panel").isVisible(), true);

    if (process.env.PANEL_SCREENSHOT) await page.screenshot({ path: process.env.PANEL_SCREENSHOT });
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await page.locator("#yjs-batch-host").boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844);
    assert.equal(await page.locator("#yjs-batch-host .brand").count(), 1);
    console.log("Verified: legacy cleanup, delayed duplicates, injection race, CSP styles, toggles, site content preserved.");
  } finally {
    await browser.close();
  }
});
