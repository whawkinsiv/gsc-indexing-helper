"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadExtension, settle } = require("./helpers/page.js");

const OPTIONS = { timeout: 20000 };

const CORE_KEY = "gscIndexingHelperCoreV2";
const HISTORY_KEY = "gscIndexingHelperHistoryV2";
const RUN_KEY_PREFIX = "gscIndexingHelperRunV2:";
const LEGACY_KEY = "gscIndexingHelperStateV1";

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days) => new Date(Date.now() - days * DAY).toISOString();

test("the panel mounts and recognizes the open report", OPTIONS, async (t) => {
  const app = await loadExtension();
  t.after(() => app.close());
  const text = app.panelText();
  assert.match(text, /GSC Indexing Helper/);
  assert.match(text, /2 URLs visible in "Crawled - currently not indexed"/);
  assert.match(text, /Ready/);
});

test("the panel offers the run buttons when nothing is queued", OPTIONS, async (t) => {
  const app = await loadExtension();
  t.after(() => app.close());
  const start = app.panel().querySelector('button[data-action="start"]');
  assert.equal(start.hasAttribute("disabled"), false);
  assert.equal(app.panel().querySelector('button[data-action="pause"]').hasAttribute("disabled"), true);
});

test("a run does not start when every visible URL was attempted recently", OPTIONS, async (t) => {
  const app = await loadExtension({
    storage: {
      [HISTORY_KEY]: {
        "https://example.com/a": { status: "success", at: daysAgo(2) },
        "https://example.com/b": { status: "failed", at: daysAgo(1) }
      }
    }
  });
  t.after(() => app.close());

  app.click("start");
  await settle();

  assert.match(app.panelText(), /All 2 visible URLs were attempted recently/);
  assert.equal(app.chrome.data[CORE_KEY].running, false);
  assert.equal(app.chrome.data[CORE_KEY].queue.length, 0);
});

test("a failed URL becomes eligible again after three days", OPTIONS, async (t) => {
  const app = await loadExtension({
    storage: {
      [HISTORY_KEY]: {
        "https://example.com/a": { status: "success", at: daysAgo(2) },
        "https://example.com/b": { status: "failed", at: daysAgo(4) }
      }
    }
  });
  t.after(() => app.close());

  app.click("start");
  await settle();

  await app.stopWorker();

  const core = app.chrome.data[CORE_KEY];
  assert.deepEqual(core.queue, ["https://example.com/b"]);
  assert.equal(core.skippedThisRun, 1);
});

test("each run is stored under its own key, separate from the live state", OPTIONS, async (t) => {
  const app = await loadExtension();
  t.after(() => app.close());
  app.click("start");
  await settle();

  await app.stopWorker();

  const core = app.chrome.data[CORE_KEY];
  assert.equal(core.runIndex.length, 1);

  const runId = core.runIndex[0].id;
  assert.ok(runId, "the run needs an id");
  // The live record holds only the run summary, never the URL items.
  assert.equal("items" in core.runIndex[0], false);

  const stored = app.chrome.data[`${RUN_KEY_PREFIX}${runId}`];
  assert.ok(stored, "the run must have its own storage key");
  assert.ok(Array.isArray(stored.items));
});

test("start-up moves a version 1 record into the split storage layout", OPTIONS, async (t) => {
  const legacyRun = {
    id: "old-run-1",
    reportName: "Crawled - currently not indexed",
    status: "completed",
    startedAt: daysAgo(1),
    finishedAt: daysAgo(1),
    checkedCount: 2,
    requestsSubmitted: 1,
    items: [
      { url: "https://example.com/a", status: "success", attempts: [{ status: "success" }] },
      { url: "https://example.com/b", status: "already_indexed", attempts: [{ status: "already_indexed" }] }
    ]
  };

  const app = await loadExtension({
    storage: {
      [LEGACY_KEY]: {
        running: false,
        queue: [],
        history: {
          "https://example.com/a": { status: "success", at: daysAgo(1) },
          "https://example.com/old": { status: "success", at: daysAgo(200) }
        },
        log: [{ at: daysAgo(1), status: "done", url: null, message: "Finished" }],
        runs: [legacyRun]
      }
    }
  });
  t.after(() => app.close());

  assert.equal(LEGACY_KEY in app.chrome.data, false, "the old key must be removed");
  assert.equal(app.chrome.data[CORE_KEY].runIndex.length, 1);
  assert.deepEqual(app.chrome.data[CORE_KEY].runIndex[0].counts, {
    success: 1, indexed: 1, failed: 0, pending: 0
  });
  assert.equal(app.chrome.data[`${RUN_KEY_PREFIX}old-run-1`].items.length, 2);

  // History older than 90 days is dropped during the move.
  assert.deepEqual(Object.keys(app.chrome.data[HISTORY_KEY]), ["https://example.com/a"]);

  // The migrated run appears in the panel.
  assert.match(app.panelText(), /1 requested - 1 indexed - 0 failed/);
});

test("a run that Chrome interrupted does not restart by itself", OPTIONS, async (t) => {
  const app = await loadExtension({
    storage: {
      [CORE_KEY]: {
        running: true,
        paused: false,
        queue: ["https://example.com/a"],
        activeRunId: "old-run-1",
        runLimit: 10,
        requestsThisRun: 3,
        checkedThisRun: 4,
        log: [],
        runIndex: [{ id: "old-run-1", reportName: "Crawled - currently not indexed", status: "running", startedAt: daysAgo(1), counts: {} }]
      }
    }
  });
  t.after(() => app.close());

  const core = app.chrome.data[CORE_KEY];
  assert.equal(core.running, false);
  assert.equal(core.paused, true);
  assert.equal(core.runIndex[0].status, "paused: browser restarted");
  assert.match(app.panelText(), /Paused - 3\/10 requests/);
});

test("the panel keeps an expanded run open when it renders again", OPTIONS, async (t) => {
  const app = await loadExtension({
    storage: {
      [CORE_KEY]: {
        runIndex: [{
          id: "old-run-1",
          reportName: "Crawled - currently not indexed",
          status: "completed",
          startedAt: daysAgo(1),
          counts: { success: 1, indexed: 0, failed: 0, pending: 0 }
        }],
        log: [],
        queue: []
      },
      [`${RUN_KEY_PREFIX}old-run-1`]: {
        id: "old-run-1",
        items: [{ url: "https://example.com/a", status: "success", attempts: [{ status: "success", message: "ok" }] }]
      }
    }
  });
  t.after(() => app.close());

  const details = app.panel().querySelector('details[data-run-id="old-run-1"]');
  assert.ok(details, "the run must appear in the panel");
  assert.equal(details.hasAttribute("open"), false);

  // Open the run, then force a render by changing the page.
  details.open = true;
  app.document.body.appendChild(app.document.createElement("div"));
  app.click("clear");
  await settle();

  const after = app.panel().querySelector('details[data-run-id="old-run-1"]');
  assert.equal(after.hasAttribute("open"), true, "the run must stay open after a render");
});

test("the panel warns the user when Chrome cannot save data", OPTIONS, async (t) => {
  const app = await loadExtension();
  t.after(() => app.close());
  app.chrome.failWrites("QUOTA_BYTES quota exceeded");

  app.click("start");
  await settle();

  await app.stopWorker();

  assert.match(app.panelText(), /Chrome could not save data/);
  assert.match(app.panelText(), /QUOTA_BYTES quota exceeded/);
});

test("the run history never appears unescaped in the panel", OPTIONS, async (t) => {
  const app = await loadExtension({
    storage: {
      [CORE_KEY]: {
        queue: [],
        runIndex: [],
        log: [{ at: daysAgo(1), status: "failed", url: null, message: `<img src=x onerror="alert(1)">` }]
      }
    }
  });
  t.after(() => app.close());

  // The panel must contain no injected element, only escaped text.
  assert.equal(app.panel().querySelector("img"), null);
  assert.match(app.panelText(), /<img src=x onerror="alert\(1\)">/);
});

test("the move from version 1 keeps a queue that the user paused", OPTIONS, async (t) => {
  const app = await loadExtension({
    storage: {
      [LEGACY_KEY]: {
        running: true,
        paused: false,
        queue: ["https://example.com/a", "https://example.com/b"],
        activeRunId: "old-run-1",
        runLimit: 10,
        checkedThisRun: 4,
        requestsThisRun: 2,
        history: {},
        log: [],
        runs: [{
          id: "old-run-1",
          reportName: "Crawled - currently not indexed",
          status: "running",
          startedAt: daysAgo(1),
          items: []
        }]
      }
    }
  });
  t.after(() => app.close());

  const core = app.chrome.data[CORE_KEY];
  assert.equal(core.running, false, "a run must never restart by itself");
  assert.equal(core.paused, true);
  assert.deepEqual(core.queue, ["https://example.com/a", "https://example.com/b"]);
  assert.equal(core.requestsThisRun, 2);
  assert.match(app.panelText(), /Paused - 2\/10 requests/);
});
