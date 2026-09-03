/**
 * GSC Indexing Helper - content script.
 *
 * The script adds a panel to Google Search Console. The panel processes URLs
 * from the "Crawled" and "Discovered - currently not indexed" reports.
 *
 * lib.js loads first and supplies the pure rules in `GSC_LIB`.
 */
(() => {
  "use strict";

  if (window.__gscIndexingHelperLoaded) return;
  window.__gscIndexingHelperLoaded = true;

  const L = globalThis.GSC_LIB;
  if (!L) {
    console.error("GSC Indexing Helper: lib.js did not load.");
    return;
  }

  const {
    BATCH_LIMIT,
    RETRY_AFTER_DAYS,
    FAILED_RETRY_AFTER_DAYS,
    MAX_CONSECUTIVE_FAILURES,
    MAX_RUNS,
    REPORT_NAMES,
    normalize,
    lower,
    escapeHtml
  } = L;

  // Storage keys. The live state, the attempt history, and each run are
  // separate. A write during a batch therefore touches one small record
  // instead of the complete log.
  const CORE_KEY = "gscIndexingHelperCoreV2";
  const HISTORY_KEY = "gscIndexingHelperHistoryV2";
  const RUN_KEY_PREFIX = "gscIndexingHelperRunV2:";
  const LEGACY_KEY = "gscIndexingHelperStateV1";

  const POLL_MS = 750;
  const PAGE_TEXT_TTL_MS = 250;
  const URL_COUNT_TTL_MS = 5000;
  const RENDER_DEBOUNCE_MS = 1000;
  const DISPLAYED_RUNS = 5;

  const DEFAULT_CORE = {
    running: false,
    paused: false,
    queue: [],
    activeUrl: null,
    checkedThisRun: 0,
    requestsThisRun: 0,
    skippedThisRun: 0,
    consecutiveFailures: 0,
    runLimit: BATCH_LIMIT,
    startedAt: null,
    reportUrl: null,
    activeRunId: null,
    log: [],
    runIndex: []
  };

  /** The live state. This record stays small and is written often. */
  let state = { ...DEFAULT_CORE };

  /** URL -> { status, at, message }. Written once per finished URL. */
  let history = {};

  /** Run id -> items array. Held in memory for the runs the panel shows. */
  const runItems = new Map();

  /** Run ids the user expanded in the panel. */
  const openRunIds = new Set();

  let workerPromise = null;
  let ui = null;
  let lastPanelHtml = "";
  let storageError = null;
  let renderTimer = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  function storageGetRaw(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(keys, (result) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result || {});
      });
    });
  }

  function storageSetRaw(payload) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(payload, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  }

  function storageRemoveRaw(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.remove(keys, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  }

  /**
   * Write to Chrome storage and report a failure in the panel.
   *
   * The function never throws. A storage failure must not stop a batch that
   * is already running, but the user must see that the log is incomplete.
   */
  async function writeStorage(payload) {
    try {
      await storageSetRaw(payload);
      if (storageError) {
        storageError = null;
        render();
      }
      return true;
    } catch (error) {
      storageError = error.message || "Chrome could not save the data.";
      console.error("GSC Indexing Helper: storage write failed.", error);
      render();
      return false;
    }
  }

  const saveCore = () => writeStorage({ [CORE_KEY]: state });
  const saveHistory = () => writeStorage({ [HISTORY_KEY]: history });

  function runKey(runId) {
    return `${RUN_KEY_PREFIX}${runId}`;
  }

  /** Write one run record with its items. Other runs are not touched. */
  function saveRun(runId) {
    const summary = findRunSummary(runId);
    if (!summary) return Promise.resolve(false);
    return writeStorage({
      [runKey(runId)]: { ...summary, items: runItems.get(runId) || [] }
    });
  }

  function findRunSummary(runId) {
    return (state.runIndex || []).find((run) => run.id === runId) || null;
  }

  async function patchCore(patch) {
    state = { ...state, ...patch };
    await saveCore();
    render();
  }

  // ---------------------------------------------------------------------------
  // Log and attempt history
  // ---------------------------------------------------------------------------

  /**
   * Add a line to the recent-activity list.
   *
   * The attempt history only records an outcome that belongs to the URL. A
   * quota stop or a CAPTCHA is a problem with the session, so it must not
   * make the extension skip that URL on the next run.
   */
  async function addLog(status, url, message) {
    const entry = {
      at: new Date().toISOString(),
      status,
      url: url || null,
      message: message || ""
    };
    state.log = [entry, ...(state.log || [])].slice(0, 100);
    await saveCore();

    if (url && ["success", "already_indexed", "failed"].includes(status)) {
      history = { ...history, [url]: { status, at: entry.at, message: entry.message } };
      await saveHistory();
    }
    render();
  }

  // ---------------------------------------------------------------------------
  // Run records
  // ---------------------------------------------------------------------------

  function newRunId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function summaryOf(run) {
    return {
      id: run.id,
      reportName: run.reportName,
      reportUrl: run.reportUrl,
      requestLimit: run.requestLimit,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      checkedCount: run.checkedCount || 0,
      requestsSubmitted: run.requestsSubmitted || 0,
      counts: L.countRunItems(run.items || [])
    };
  }

  async function updateActiveRun(patch) {
    const index = (state.runIndex || []).findIndex((run) => run.id === state.activeRunId);
    if (index < 0) return;
    const runIndex = [...state.runIndex];
    runIndex[index] = {
      ...runIndex[index],
      ...patch,
      counts: L.countRunItems(runItems.get(state.activeRunId) || [])
    };
    state.runIndex = runIndex;
    await saveCore();
    await saveRun(state.activeRunId);
    render();
  }

  async function updateRunItem(url, status, message = "") {
    const runId = state.activeRunId;
    if (!runId || !findRunSummary(runId)) return;

    const items = [...(runItems.get(runId) || [])];
    let itemIndex = items.findIndex((item) => item.url === url);
    if (itemIndex < 0) {
      items.push({ url, status: "queued", message: "", startedAt: null, finishedAt: null, attempts: [] });
      itemIndex = items.length - 1;
    }

    const now = new Date().toISOString();
    const existing = items[itemIndex];
    const attempts = [...(existing.attempts || [])];

    if (status === "working") {
      attempts.push({ status, message, startedAt: now, finishedAt: null });
    } else if (L.TERMINAL_STATUSES.includes(status)) {
      const openIndex = attempts.findLastIndex((attempt) => attempt.status === "working" && !attempt.finishedAt);
      const startedAt = openIndex >= 0 ? attempts[openIndex].startedAt : now;
      const finished = { status, message, startedAt, finishedAt: now };
      if (openIndex >= 0) attempts[openIndex] = { ...attempts[openIndex], ...finished };
      else attempts.push(finished);
    }

    items[itemIndex] = {
      ...existing,
      status,
      message,
      startedAt: existing.startedAt || (status === "working" ? now : null),
      finishedAt: L.TERMINAL_STATUSES.includes(status) ? now : null,
      attempts
    };

    runItems.set(runId, items);
    await updateActiveRun({});
  }

  async function cancelUnfinishedRunItems() {
    const runId = state.activeRunId;
    if (!runId || !findRunSummary(runId)) return;

    const now = new Date().toISOString();
    const items = (runItems.get(runId) || []).map((item) => {
      if (!["queued", "working"].includes(item.status)) return item;
      const attempts = [...(item.attempts || [])];
      const openIndex = attempts.findLastIndex((attempt) => attempt.status === "working" && !attempt.finishedAt);
      if (openIndex >= 0) {
        attempts[openIndex] = {
          ...attempts[openIndex],
          status: "cancelled",
          message: "Queue cleared by user.",
          finishedAt: now
        };
      }
      return { ...item, status: "cancelled", message: "Queue cleared by user.", finishedAt: now, attempts };
    });

    runItems.set(runId, items);
    await updateActiveRun({ status: "cancelled", finishedAt: now });
  }

  /** Keep the newest runs and delete the storage keys of the older runs. */
  async function pruneStoredRuns() {
    const { kept, dropped } = L.pruneRunIndex(state.runIndex || [], MAX_RUNS);
    if (!dropped.length) return;
    state.runIndex = kept;
    for (const id of dropped) runItems.delete(id);
    await saveCore();
    try {
      await storageRemoveRaw(dropped.map(runKey));
    } catch (error) {
      console.error("GSC Indexing Helper: could not remove old runs.", error);
    }
  }

  // ---------------------------------------------------------------------------
  // Page reading
  // ---------------------------------------------------------------------------

  // `innerText` makes the browser measure the page layout. Search Console is a
  // large application, so the result is cached for a short time. One poll tick
  // then reads the page once instead of three or four times.
  let pageTextCache = { text: "", lower: "", at: 0 };

  function pageText() {
    const now = Date.now();
    if (now - pageTextCache.at < PAGE_TEXT_TTL_MS) return pageTextCache.text;
    const text = normalize(document.body ? document.body.innerText : "");
    pageTextCache = { text, lower: text.toLowerCase(), at: now };
    return text;
  }

  function pageTextLower() {
    pageText();
    return pageTextCache.lower;
  }

  function visible(element) {
    if (!(element instanceof Element)) return false;
    // Test the box first. Most elements fail here, which avoids the more
    // expensive style lookup below.
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function currentReportName() {
    return L.matchReportName(pageText());
  }

  function onTargetReport() {
    return Boolean(currentReportName());
  }

  function extractReportUrls() {
    const urls = [];
    const rowSelectors = ["table tr", "[role='row']", "[role='gridcell']", "[role='cell']"];

    for (const element of document.querySelectorAll(rowSelectors.join(","))) {
      if (!visible(element)) continue;
      urls.push(...L.urlsFromText(element.innerText || element.textContent || ""));
      for (const anchor of element.querySelectorAll("a[href]")) {
        const href = anchor.getAttribute("href");
        if (L.validPublicUrl(href)) urls.push(href);
        urls.push(...L.urlsFromText(anchor.innerText || ""));
      }
    }

    if (!urls.length) {
      for (const element of document.querySelectorAll("a, button, [role='button']")) {
        if (!visible(element)) continue;
        urls.push(...L.urlsFromText(element.innerText || element.textContent || ""));
      }
    }

    return L.dedupe(urls);
  }

  // The full row scan is expensive. The panel only needs an approximate count,
  // so the result is cached. The scan never runs during a batch.
  let urlCountCache = { href: "", count: 0, at: 0 };

  function visibleUrlCount() {
    const now = Date.now();
    const samePage = urlCountCache.href === location.href;
    const stale = !samePage || now - urlCountCache.at > URL_COUNT_TTL_MS;
    if (stale && !state.running) {
      urlCountCache = { href: location.href, count: extractReportUrls().length, at: now };
    }
    return urlCountCache.href === location.href ? urlCountCache.count : null;
  }

  function allActionElements() {
    return [...document.querySelectorAll("button, a, [role='button']")].filter(visible);
  }

  function exactAction(names) {
    const wanted = names.map(lower);
    return allActionElements().find((element) => wanted.includes(lower(element.innerText || element.textContent)));
  }

  /**
   * Return true when a visible element's own text equals one of the names.
   *
   * The cheap page-text test runs first. The expensive element scan runs only
   * when the phrase is somewhere on the page.
   */
  function hasExactVisibleText(names) {
    const wanted = names.map(lower);
    const text = pageTextLower();
    if (!wanted.some((name) => text.includes(name))) return false;

    const selectors = "h1, h2, h3, h4, [role='heading'], [role='status'], [role='alert'], div, span";
    return [...document.querySelectorAll(selectors)].some((element) =>
      wanted.includes(lower(element.innerText || element.textContent)) && visible(element)
    );
  }

  function actionEnabled(element) {
    return Boolean(element) &&
      !element.disabled &&
      lower(element.getAttribute("aria-disabled")) !== "true";
  }

  function findExactUrlAction(url) {
    const elements = [...document.querySelectorAll("a, button, [role='button'], [role='cell'], [role='gridcell']")]
      .filter(visible);
    const exact = elements.find((element) => normalize(element.innerText || element.textContent) === url);
    if (!exact) return null;
    return exact.closest("a, button, [role='button']") || exact;
  }

  function findInspectionInput() {
    const selectors = [
      "input[placeholder*='Inspect any URL' i]",
      "input[aria-label*='Inspect any URL' i]",
      "input[placeholder*='inspect' i][placeholder*='URL' i]",
      "input[aria-label*='inspect' i][aria-label*='URL' i]",
      "[contenteditable='true'][aria-label*='inspect' i]"
    ];
    return [...document.querySelectorAll(selectors.join(","))].find(visible) || null;
  }

  function setNativeValue(input, value) {
    input.focus();
    if (input.isContentEditable) {
      input.textContent = value;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      return;
    }
    const prototype = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function pressEnter(input) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      input.dispatchEvent(new KeyboardEvent(type, {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }));
    }
  }

  async function waitFor(predicate, timeoutMs, label) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (state.paused || !state.running) throw new Error("PAUSED");
      const result = predicate();
      if (result) return result;
      await sleep(POLL_MS);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  // ---------------------------------------------------------------------------
  // The indexing workflow
  // ---------------------------------------------------------------------------

  async function openInspection(url) {
    // Prefer the report's own URL -> INSPECT flow when the row is available.
    const rowAction = findExactUrlAction(url);
    if (rowAction && onTargetReport()) {
      rowAction.click();
      try {
        const inspect = await waitFor(
          () => exactAction(["INSPECT", "INSPECT URL"]),
          10000,
          "the report's INSPECT button"
        );
        inspect.click();
        await sleep(2500);
        return;
      } catch (error) {
        if (error.message === "PAUSED") throw error;
      }
    }

    // Fallback: the inspection box is present at the top of every screen.
    const input = await waitFor(findInspectionInput, 15000, "the URL inspection box");
    setNativeValue(input, url);
    await sleep(250);
    pressEnter(input);
    await sleep(2500);
  }

  async function waitForInspectionResult() {
    return waitFor(() => {
      if (L.isInspectionBusy(pageText())) return null;
      const blocked = L.classifyBlocker(pageText());
      if (blocked) return { type: "blocked", message: blocked.message, hard: blocked.hard };
      if (hasExactVisibleText(["URL is on Google"])) {
        return { type: "already_indexed", message: "URL is already on Google; no indexing request was submitted." };
      }
      const requestButton = exactAction(["REQUEST INDEXING"]);
      if (actionEnabled(requestButton)) return { type: "ready", button: requestButton };
      return null;
    }, 180000, "Google's URL inspection result");
  }

  /**
   * Remove a confirmation message that belongs to the previous URL.
   *
   * Google leaves the confirmation on the page while it fades out. The
   * function clicks the dismiss button and then waits for the text to go.
   * A clean page makes the next confirmation unambiguous.
   */
  async function dismissLingeringSuccess() {
    pageTextCache.at = 0;
    if (!L.findNewSuccess(pageText(), "")) return;

    const dismiss = exactAction(["GOT IT", "OK", "DISMISS", "CLOSE"]);
    if (dismiss) dismiss.click();

    const started = Date.now();
    while (Date.now() - started < 10000) {
      await sleep(500);
      pageTextCache.at = 0;
      if (!L.findNewSuccess(pageText(), "")) return;
    }
  }

  async function requestIndexing(button) {
    if (!button || !visible(button) || !actionEnabled(button)) {
      throw new Error("Request indexing button disappeared or became unavailable");
    }

    await dismissLingeringSuccess();

    // Record the page text before the click. The extension accepts a
    // confirmation only when the text was not already present. This stops an
    // old message from counting as a new success.
    pageTextCache.at = 0;
    const textBeforeClick = pageText();
    button.click();

    const outcome = await waitFor(() => {
      const success = L.findNewSuccess(pageText(), textBeforeClick);
      if (success) return { type: "success", message: success };
      const blocked = L.classifyBlocker(pageText());
      if (blocked) return { type: "blocked", message: blocked.message, hard: blocked.hard };
      return null;
    }, 240000, "Google's indexing confirmation");

    const dismiss = exactAction(["GOT IT", "OK", "DISMISS", "CLOSE"]);
    if (dismiss) dismiss.click();
    return outcome;
  }

  async function processOne(url) {
    await patchCore({ activeUrl: url });
    await updateRunItem(url, "working", "Opening URL inspection.");
    await addLog("working", url, "Opening URL inspection.");
    await openInspection(url);

    const result = await waitForInspectionResult();
    if (result.type !== "ready") return result;

    await addLog("working", url, "Inspection loaded; requesting indexing.");
    return requestIndexing(result.button);
  }

  async function recordSuccess(url, message) {
    await updateRunItem(url, "success", message);
    state.queue = state.queue.slice(1);
    state.checkedThisRun += 1;
    state.requestsThisRun += 1;
    state.consecutiveFailures = 0;
    state.activeUrl = null;
    await addLog("success", url, message);
    await updateActiveRun({
      checkedCount: state.checkedThisRun,
      requestsSubmitted: state.requestsThisRun
    });
  }

  async function recordAlreadyIndexed(url, message) {
    await updateRunItem(url, "already_indexed", message);
    state.queue = state.queue.slice(1);
    state.checkedThisRun += 1;
    state.consecutiveFailures = 0;
    state.activeUrl = null;
    await addLog("already_indexed", url, message);
    await updateActiveRun({
      checkedCount: state.checkedThisRun,
      requestsSubmitted: state.requestsThisRun
    });
  }

  /**
   * Record a problem with one URL and move on.
   *
   * The failure goes into the attempt history. The extension then skips that
   * URL for three days. This stops one broken URL from blocking every later
   * run, because the report shows the same URL first each day.
   */
  async function recordSoftFailure(url, message) {
    await updateRunItem(url, "failed", message);
    state.queue = state.queue.slice(1);
    state.checkedThisRun += 1;
    state.consecutiveFailures += 1;
    state.activeUrl = null;
    await addLog("failed", url, message);
    await updateActiveRun({
      checkedCount: state.checkedThisRun,
      requestsSubmitted: state.requestsThisRun
    });
  }

  /**
   * Stop the whole run.
   *
   * The URL stays at the front of the queue so that Resume tries it again.
   * The attempt history is not changed, because the account or the browser
   * session caused the problem, not the URL.
   */
  async function recordHardStop(url, message, quota) {
    await updateRunItem(url, "failed", message);
    state.checkedThisRun += 1;
    await addLog(quota ? "quota" : "blocked", url, message);
    await updateActiveRun({
      status: quota ? "stopped: quota" : "stopped: blocked",
      checkedCount: state.checkedThisRun,
      requestsSubmitted: state.requestsThisRun
    });
    await patchCore({ running: false, paused: true, activeUrl: null });
  }

  async function runWorker() {
    if (workerPromise) return workerPromise;

    workerPromise = (async () => {
      while (
        state.running &&
        !state.paused &&
        state.queue.length &&
        state.requestsThisRun < state.runLimit
      ) {
        const url = state.queue[0];
        let outcome;

        try {
          outcome = await processOne(url);
        } catch (error) {
          if (error.message === "PAUSED") break;
          // A timeout or an unexpected error affects this URL only.
          outcome = {
            type: "blocked",
            hard: false,
            message: error.message || "Unexpected extension error."
          };
        }

        if (outcome.type === "already_indexed") {
          await recordAlreadyIndexed(url, outcome.message);
          await sleep(750);
          continue;
        }

        if (outcome.type === "success") {
          await recordSuccess(url, outcome.message);
          await sleep(1500);
          continue;
        }

        const quota = /quota/i.test(outcome.message);
        if (outcome.hard) {
          await recordHardStop(url, outcome.message, quota);
          break;
        }

        await recordSoftFailure(url, outcome.message);

        if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          await updateActiveRun({
            status: "stopped: repeated failures",
            finishedAt: new Date().toISOString()
          });
          await addLog(
            "blocked",
            null,
            `Stopped after ${MAX_CONSECUTIVE_FAILURES} failures in a row. Check Search Console yourself.`
          );
          await patchCore({ running: false, paused: true, activeUrl: null });
          break;
        }

        await sleep(1000);
      }

      const requestLimitReached = state.requestsThisRun >= state.runLimit;
      const candidatesExhausted = !state.queue.length;
      if (state.running && (requestLimitReached || candidatesExhausted)) {
        await updateActiveRun({
          status: requestLimitReached ? "completed" : "completed: candidates exhausted",
          finishedAt: new Date().toISOString(),
          checkedCount: state.checkedThisRun,
          requestsSubmitted: state.requestsThisRun
        });
        await patchCore({ running: false, paused: false, queue: [], activeUrl: null });
        await addLog(
          "done",
          null,
          `Submitted ${state.requestsThisRun}/${state.runLimit} indexing requests after checking ${state.checkedThisRun} URL${state.checkedThisRun === 1 ? "" : "s"}.`
        );
      }
    })().finally(() => {
      workerPromise = null;
      render();
    });

    return workerPromise;
  }

  // ---------------------------------------------------------------------------
  // Panel actions
  // ---------------------------------------------------------------------------

  async function startBatch(limit = BATCH_LIMIT) {
    const reportName = currentReportName();
    if (!reportName) {
      await addLog("failed", null, `Open either "${REPORT_NAMES[0]}" or "${REPORT_NAMES[1]}" first.`);
      return;
    }

    const now = Date.now();
    const found = extractReportUrls();
    urlCountCache = { href: location.href, count: found.length, at: now };

    const eligible = found.filter((url) => !L.skipReason(history, url, now));
    const skipped = found.length - eligible.length;

    if (!eligible.length) {
      const explanation = found.length
        ? `All ${found.length} visible URLs were attempted recently. A successful URL waits ${RETRY_AFTER_DAYS} days and a failed URL waits ${FAILED_RETRY_AFTER_DAYS} days.`
        : "No full URLs were found in the visible report rows.";
      await addLog("failed", null, explanation);
      return;
    }

    const startedAt = new Date().toISOString();
    const runId = newRunId();
    const summary = {
      id: runId,
      reportName,
      reportUrl: location.href,
      requestLimit: limit,
      checkedCount: 0,
      requestsSubmitted: 0,
      status: "running",
      startedAt,
      finishedAt: null,
      counts: { success: 0, indexed: 0, failed: 0, pending: 0 }
    };

    runItems.set(runId, []);
    history = L.pruneHistory(history, now);
    await saveHistory();

    await patchCore({
      running: true,
      paused: false,
      queue: eligible,
      activeUrl: null,
      checkedThisRun: 0,
      requestsThisRun: 0,
      skippedThisRun: skipped,
      consecutiveFailures: 0,
      runLimit: limit,
      startedAt,
      reportUrl: location.href,
      activeRunId: runId,
      runIndex: [summary, ...(state.runIndex || [])]
    });

    await saveRun(runId);
    await pruneStoredRuns();

    await addLog(
      "started",
      null,
      `Found ${eligible.length} candidate URL${eligible.length === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped)` : ""}; stopping after ${limit} accepted request${limit === 1 ? "" : "s"}.`
    );
    runWorker();
  }

  async function togglePause() {
    if (state.running && !state.paused) {
      await patchCore({ paused: true, running: false });
      await updateActiveRun({ status: "paused" });
      await addLog("paused", state.activeUrl, "Paused by user.");
      return;
    }

    if (state.queue.length) {
      await patchCore({ paused: false, running: true, consecutiveFailures: 0 });
      await updateActiveRun({ status: "running" });
      await addLog("started", state.activeUrl, "Resumed queue.");
      runWorker();
    }
  }

  async function clearQueue() {
    await cancelUnfinishedRunItems();
    await patchCore({
      running: false,
      paused: false,
      queue: [],
      activeUrl: null,
      checkedThisRun: 0,
      requestsThisRun: 0,
      skippedThisRun: 0,
      consecutiveFailures: 0,
      runLimit: BATCH_LIMIT,
      startedAt: null,
      activeRunId: null
    });
    await addLog("cleared", null, "Queue cleared. Attempt history was kept.");
  }

  /** Read every stored run and download the complete log as CSV. */
  async function exportRunLog() {
    const index = state.runIndex || [];
    if (!index.length) return;

    let stored = {};
    try {
      stored = await storageGetRaw(index.map((run) => runKey(run.id)));
    } catch (error) {
      storageError = error.message || "Chrome could not read the run log.";
      console.error("GSC Indexing Helper: export failed.", error);
      render();
      return;
    }

    const runs = index.map((summary) => {
      const record = stored[runKey(summary.id)];
      return { ...summary, items: (record && record.items) || runItems.get(summary.id) || [] };
    });

    const blob = new Blob([L.buildCsv(runs)], { type: "text/csv;charset=utf-8" });
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = `gsc-indexing-runs-${new Date().toISOString().slice(0, 10)}.csv`;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
  }

  // ---------------------------------------------------------------------------
  // Panel
  // ---------------------------------------------------------------------------

  function statusLabel() {
    if (state.running) return `Working - ${state.requestsThisRun}/${state.runLimit} requests - ${state.checkedThisRun} checked`;
    if (state.paused && state.queue.length) return `Paused - ${state.requestsThisRun}/${state.runLimit} requests`;
    if (state.checkedThisRun) return `Last run - ${state.requestsThisRun} requests - ${state.checkedThisRun} checked`;
    return "Ready";
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }

  function reportBannerHtml() {
    const reportName = currentReportName();
    if (!reportName) {
      return `<div class="report warn">Open a Crawled or Discovered "currently not indexed" detail report</div>`;
    }
    const count = visibleUrlCount();
    const countText = count === null
      ? "Report open"
      : `${count} URL${count === 1 ? "" : "s"} visible`;
    return `<div class="report ok">${escapeHtml(countText)} in "${escapeHtml(reportName)}"</div>`;
  }

  function runItemsHtml(runId) {
    const items = runItems.get(runId);
    if (!items) return `<div class="run-item"><span>-</span><div>Expand after a reload to load details.</div></div>`;
    return items.flatMap((item) => {
      const attempts = (item.attempts && item.attempts.length)
        ? item.attempts
        : [{ status: item.status, message: item.message }];
      return attempts.map((attempt) => `
        <div class="run-item ${escapeHtml(attempt.status)}">
          <span>${escapeHtml(attempt.status)}</span>
          <div title="${escapeHtml(attempt.message || item.url)}">${escapeHtml(item.url)}</div>
        </div>`);
    }).join("");
  }

  function panelHtml() {
    const recent = (state.log || []).slice(0, 5);
    const recentRuns = (state.runIndex || []).slice(0, DISPLAYED_RUNS);
    const busy = state.running || state.queue.length > 0;

    return `
      <div class="head">
        <div>
          <div class="title">GSC Indexing Helper</div>
          <div class="status">${escapeHtml(statusLabel())}</div>
        </div>
        <button class="icon" data-action="collapse" title="Minimize">-</button>
      </div>
      <div class="body">
        ${storageError ? `<div class="report error">Chrome could not save data: ${escapeHtml(storageError)}. The run log may be incomplete.</div>` : ""}
        ${reportBannerHtml()}
        ${state.activeUrl ? `<div class="active"><strong>Current</strong><span>${escapeHtml(state.activeUrl)}</span></div>` : ""}
        <div class="buttons">
          <button data-action="start-one" ${busy ? "disabled" : ""}>Submit one</button>
          <button class="primary" data-action="start" ${busy ? "disabled" : ""}>Run first 10</button>
          <button data-action="pause" ${!state.queue.length ? "disabled" : ""}>${state.running ? "Pause" : "Resume"}</button>
          <button data-action="clear" ${!state.queue.length && !state.activeUrl ? "disabled" : ""}>Clear</button>
        </div>
        <div class="note">Only an accepted Request indexing submission counts toward 10. "URL is on Google" counts as 0 and moves on. A failed URL is skipped and the run continues. The run stops on a quota message, a CAPTCHA, or ${MAX_CONSECUTIVE_FAILURES} failures in a row. Set the report to show 25-50 rows.</div>
        <div class="log">
          ${recent.length ? recent.map((item) => `
            <div class="log-row ${escapeHtml(item.status)}">
              <span>${escapeHtml(item.status)}</span>
              <div title="${escapeHtml(item.message || item.url)}">${escapeHtml(item.url || item.message)}</div>
            </div>`).join("") : `<div class="empty">No activity yet.</div>`}
        </div>
        <div class="history-head">
          <strong>Permanent run log</strong>
          <button class="small" data-action="export" ${!recentRuns.length ? "disabled" : ""}>Export CSV</button>
        </div>
        <div class="runs">
          ${recentRuns.length ? recentRuns.map((run) => {
            const counts = run.counts || { success: 0, indexed: 0, failed: 0, pending: 0 };
            return `
              <details class="run" data-run-id="${escapeHtml(run.id)}" ${openRunIds.has(run.id) ? "open" : ""}>
                <summary>
                  <span>${escapeHtml(formatDate(run.startedAt))}</span>
                  <span class="counts">${counts.success} requested - ${counts.indexed} indexed - ${counts.failed} failed${counts.pending ? ` - ${counts.pending} pending` : ""}</span>
                </summary>
                <div class="run-meta">${escapeHtml(run.reportName)} - ${escapeHtml(run.status)}</div>
                ${runItemsHtml(run.id)}
              </details>`;
          }).join("") : `<div class="empty">No completed or attempted runs yet.</div>`}
        </div>
      </div>`;
  }

  function render() {
    if (!ui) return;
    const html = panelHtml();
    // Rebuild the panel only when the markup changed. This keeps the browser
    // from re-creating the run list every time Search Console changes its DOM.
    if (html === lastPanelHtml) return;
    lastPanelHtml = html;
    ui.panel.innerHTML = html;
  }

  function mount() {
    const host = document.createElement("div");
    host.id = "gsc-indexing-helper-host";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .panel { width: 370px; max-height: min(720px, calc(100vh - 36px)); overflow: hidden auto; border: 1px solid #d9dee8; border-radius: 14px; background: #fff; color: #202124; box-shadow: 0 8px 32px rgba(31,35,41,.22); font: 13px/1.4 Arial, sans-serif; }
        .head { display: flex; align-items: center; justify-content: space-between; padding: 13px 14px; color: #fff; background: #1a73e8; }
        .title { font-size: 15px; font-weight: 700; }
        .status { margin-top: 2px; color: rgba(255,255,255,.82); font-size: 12px; }
        button { border: 1px solid #c8ccd4; border-radius: 8px; background: #fff; color: #303134; padding: 8px 10px; cursor: pointer; font-weight: 600; }
        button:hover:not(:disabled) { background: #f4f7fc; }
        button:disabled { cursor: default; opacity: .45; }
        button.primary { border-color: #1a73e8; background: #1a73e8; color: #fff; }
        button.primary:hover:not(:disabled) { background: #155fc0; }
        button.icon { border: 0; background: transparent; color: #fff; padding: 2px 7px; font-size: 20px; }
        .body { padding: 12px 14px 14px; }
        .report { margin-bottom: 10px; border-radius: 8px; padding: 8px 10px; }
        .report.ok { background: #e6f4ea; color: #137333; }
        .report.warn { background: #fef7e0; color: #8a4b00; }
        .report.error { background: #fce8e6; color: #b3261e; }
        .active { display: grid; gap: 3px; margin-bottom: 10px; }
        .active span { overflow: hidden; color: #5f6368; text-overflow: ellipsis; white-space: nowrap; }
        .buttons { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 10px; }
        .note { color: #6b7077; font-size: 11px; }
        .log { display: grid; gap: 5px; margin-top: 11px; padding-top: 10px; border-top: 1px solid #eceff3; }
        .log-row { display: grid; grid-template-columns: 54px 1fr; gap: 7px; min-width: 0; }
        .log-row > span { color: #6b7077; font-size: 10px; font-weight: 700; text-transform: uppercase; }
        .log-row > div { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .log-row.success > span, .log-row.done > span { color: #137333; }
        .log-row.already_indexed > span { color: #1a73e8; }
        .log-row.failed > span, .log-row.blocked > span, .log-row.quota > span { color: #b3261e; }
        .history-head { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; padding-top: 10px; border-top: 1px solid #eceff3; }
        button.small { padding: 5px 8px; font-size: 11px; }
        .runs { display: grid; gap: 7px; margin-top: 8px; }
        .run { border: 1px solid #e1e5eb; border-radius: 8px; padding: 7px 8px; }
        .run summary { display: flex; justify-content: space-between; gap: 8px; cursor: pointer; font-size: 11px; }
        .counts { color: #5f6368; white-space: nowrap; }
        .run-meta { margin: 7px 0; color: #6b7077; font-size: 10px; }
        .run-item { display: grid; grid-template-columns: 58px 1fr; gap: 6px; min-width: 0; margin-top: 4px; }
        .run-item > span { color: #6b7077; font-size: 9px; font-weight: 700; text-transform: uppercase; }
        .run-item.success > span { color: #137333; }
        .run-item.already_indexed > span { color: #1a73e8; }
        .run-item.failed > span, .run-item.cancelled > span { color: #b3261e; }
        .run-item > div { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
        .empty { color: #80868b; }
        .collapsed .body { display: none; }
        .collapsed { width: 230px; }
      </style>
      <section class="panel" aria-label="GSC Indexing Helper"></section>`;
    document.documentElement.appendChild(host);
    const panel = shadow.querySelector(".panel");
    ui = { host, shadow, panel };

    shadow.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const action = button.dataset.action;
      if (action === "start") startBatch();
      if (action === "start-one") startBatch(1);
      if (action === "pause") togglePause();
      if (action === "clear") clearQueue();
      if (action === "export") exportRunLog();
      if (action === "collapse") {
        panel.classList.toggle("collapsed");
        button.textContent = panel.classList.contains("collapsed") ? "+" : "-";
      }
    });

    // Remember which runs the user expanded. A render must not close them.
    // The toggle event does not bubble, so the listener uses the capture phase.
    shadow.addEventListener("toggle", (event) => {
      const details = event.target;
      if (!(details instanceof HTMLDetailsElement)) return;
      const runId = details.dataset.runId;
      if (!runId) return;
      if (details.open) openRunIds.add(runId);
      else openRunIds.delete(runId);
    }, true);

    render();
  }

  // ---------------------------------------------------------------------------
  // Start-up
  // ---------------------------------------------------------------------------

  /**
   * Move data from the single version 1 record into the split layout.
   *
   * Version 1 kept the live state, the history, and every run under one key.
   * Each small update rewrote the complete log.
   */
  async function migrateLegacyState() {
    const raw = await storageGetRaw([LEGACY_KEY]);
    const old = raw[LEGACY_KEY];
    if (!old) return false;

    const oldRuns = Array.isArray(old.runs) ? old.runs : [];
    const { kept } = L.pruneRunIndex(oldRuns, MAX_RUNS);

    const payload = {};
    const runIndex = [];
    for (const run of kept) {
      if (!run || !run.id) continue;
      runIndex.push(summaryOf(run));
      payload[runKey(run.id)] = run;
    }

    payload[HISTORY_KEY] = L.pruneHistory(old.history || {});
    payload[CORE_KEY] = {
      ...DEFAULT_CORE,
      // Keep a queue that the user paused before the update. The run never
      // restarts by itself, so `running` stays false.
      running: false,
      paused: Array.isArray(old.queue) && old.queue.length > 0,
      queue: Array.isArray(old.queue) ? old.queue : [],
      activeRunId: old.activeRunId || null,
      runLimit: old.runLimit || DEFAULT_CORE.runLimit,
      checkedThisRun: old.checkedThisRun || 0,
      requestsThisRun: old.requestsThisRun || 0,
      startedAt: old.startedAt || null,
      reportUrl: old.reportUrl || null,
      log: Array.isArray(old.log) ? old.log.slice(0, 100) : [],
      runIndex
    };

    await storageSetRaw(payload);
    await storageRemoveRaw([LEGACY_KEY]);
    console.info(`GSC Indexing Helper: moved ${runIndex.length} run(s) to the new storage layout.`);
    return true;
  }

  async function loadState() {
    const raw = await storageGetRaw([CORE_KEY, HISTORY_KEY]);
    const core = raw[CORE_KEY] || {};
    state = {
      ...DEFAULT_CORE,
      ...core,
      queue: Array.isArray(core.queue) ? core.queue : [],
      log: Array.isArray(core.log) ? core.log : [],
      runIndex: Array.isArray(core.runIndex) ? core.runIndex : []
    };
    history = raw[HISTORY_KEY] || {};

    // Load the items for the runs the panel shows. Older runs stay on disk
    // and are read only when the user exports the CSV.
    const shown = state.runIndex.slice(0, DISPLAYED_RUNS);
    if (shown.length) {
      const stored = await storageGetRaw(shown.map((run) => runKey(run.id)));
      for (const run of shown) {
        const record = stored[runKey(run.id)];
        if (record && Array.isArray(record.items)) runItems.set(run.id, record.items);
      }
    }
  }

  async function init() {
    try {
      await migrateLegacyState();
      await loadState();
    } catch (error) {
      storageError = error.message || "Chrome could not read the stored data.";
      console.error("GSC Indexing Helper: could not read storage.", error);
    }

    // Never resume a click sequence only because Chrome reopened a tab.
    if (state.running) {
      state.running = false;
      state.paused = state.queue.length > 0;
      const index = state.runIndex.findIndex((run) => run.id === state.activeRunId);
      if (index >= 0) {
        state.runIndex[index] = { ...state.runIndex[index], status: "paused: browser restarted" };
      }
      await saveCore();
    }

    mount();

    const observer = new MutationObserver(() => {
      clearTimeout(renderTimer);
      renderTimer = setTimeout(render, RENDER_DEBOUNCE_MS);
    });
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  }

  init().catch((error) => console.error("GSC Indexing Helper failed to initialize", error));
})();
