"use strict";

/**
 * Build a simulated Search Console page and load the extension into it.
 *
 * The helper supplies the parts of Chrome and the browser that jsdom does
 * not provide. It then runs the real lib.js and content.js files.
 */

const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..", "..");
const LIB_SOURCE = fs.readFileSync(path.join(ROOT, "lib.js"), "utf8");
const CONTENT_SOURCE = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");

const REPORT_TITLE = "Crawled - currently not indexed";

function reportHtml(urls) {
  const rows = urls.map((url) => `<tr role="row"><td role="cell">${url}</td></tr>`).join("");
  return `<!doctype html><html><body>
    <h1>Page indexing</h1>
    <h2>${REPORT_TITLE}</h2>
    <input aria-label="Inspect any URL in domain.example" />
    <table><tbody>${rows}</tbody></table>
  </body></html>`;
}

/** An in-memory replacement for chrome.storage.local. */
function fakeChrome(initialData = {}) {
  const data = { ...initialData };
  const runtime = { lastError: undefined };
  let failWrites = null;

  const local = {
    get(keys, callback) {
      const list = Array.isArray(keys) ? keys : [keys];
      const result = {};
      for (const key of list) {
        if (key in data) result[key] = JSON.parse(JSON.stringify(data[key]));
      }
      runtime.lastError = undefined;
      queueMicrotask(() => callback(result));
    },
    set(payload, callback) {
      if (failWrites) {
        runtime.lastError = { message: failWrites };
        queueMicrotask(() => {
          callback();
          runtime.lastError = undefined;
        });
        return;
      }
      Object.assign(data, JSON.parse(JSON.stringify(payload)));
      runtime.lastError = undefined;
      queueMicrotask(() => callback());
    },
    remove(keys, callback) {
      for (const key of (Array.isArray(keys) ? keys : [keys])) delete data[key];
      runtime.lastError = undefined;
      queueMicrotask(() => callback());
    }
  };

  return {
    api: { storage: { local }, runtime },
    data,
    failWrites(message) { failWrites = message; },
    allowWrites() { failWrites = null; }
  };
}

function panel(window) {
  const host = window.document.getElementById("gsc-indexing-helper-host");
  if (!host) throw new Error("The extension panel did not mount.");
  return host.shadowRoot.querySelector(".panel");
}

/** Let every queued promise callback run. */
async function settle(rounds = 30) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Create the page, load the extension, and wait for start-up to finish.
 *
 * @param {{urls?: string[], storage?: object}} options
 */
async function loadExtension(options = {}) {
  const urls = options.urls || ["https://example.com/a", "https://example.com/b"];
  const dom = new JSDOM(reportHtml(urls), {
    url: "https://search.google.com/search-console/index?resource_id=sc-domain%3Aexample.com",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });

  const { window } = dom;

  // jsdom has no layout engine, so every box measures zero. The extension
  // treats a zero-size box as hidden, so the test reports a real size.
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0 };
  };

  // jsdom does not implement innerText. The extension reads visible text, and
  // textContent is close enough for a page with no hidden nodes.
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    configurable: true,
    get() { return this.textContent; },
    set(value) { this.textContent = value; }
  });

  if (!window.crypto) window.crypto = {};
  if (!window.crypto.randomUUID) {
    let counter = 0;
    window.crypto.randomUUID = () => `test-run-${++counter}`;
  }

  const chromeStub = fakeChrome(options.storage || {});
  window.chrome = chromeStub.api;

  window.eval(LIB_SOURCE);
  window.eval(CONTENT_SOURCE);

  // Start-up reads storage, so let the pending promises settle.
  await settle();

  const app = {
    dom,
    window,
    document: window.document,
    chrome: chromeStub,
    panel: () => panel(window),
    panelText: () => panel(window).textContent.replace(/\s+/g, " ").trim(),
    click: (action) => {
      const button = panel(window).querySelector(`button[data-action="${action}"]`);
      if (!button) throw new Error(`No button for action "${action}"`);
      button.click();
    },

    /**
     * Stop the background worker that a batch starts.
     *
     * The worker checks the pause flag once per poll. The test waits for one
     * poll so that the worker leaves its loop before the page closes.
     */
    stopWorker: async () => {
      const pause = panel(window).querySelector('button[data-action="pause"]');
      if (pause && !pause.hasAttribute("disabled")) pause.click();
      await settle();
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await settle();
    },

    /** Close the page and release every pending timer. */
    close: () => {
      try {
        window.close();
      } catch {
        // The page is already gone.
      }
    }
  };

  return app;
}

module.exports = { loadExtension, settle, REPORT_TITLE };
