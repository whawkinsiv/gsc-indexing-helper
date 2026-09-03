(() => {
  "use strict";

  if (window.__gscIndexingHelperLoaded) return;
  window.__gscIndexingHelperLoaded = true;

  const STORAGE_KEY = "gscIndexingHelperStateV1";
  const BATCH_LIMIT = 10;
  const RETRY_AFTER_DAYS = 14;
  const REPORT_NAMES = [
    "Crawled - currently not indexed",
    "Discovered - currently not indexed"
  ];
  const POLL_MS = 750;

  const DEFAULT_STATE = {
    running: false,
    paused: false,
    queue: [],
    activeUrl: null,
    completedThisRun: 0,
    checkedThisRun: 0,
    requestsThisRun: 0,
    runLimit: BATCH_LIMIT,
    startedAt: null,
    reportUrl: null,
    activeRunId: null,
    history: {},
    log: [],
    runs: []
  };

  let state = { ...DEFAULT_STATE };
  let workerPromise = null;
  let ui = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = (value) => (value || "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  const lower = (value) => normalize(value).toLowerCase();

  function visible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function validPublicUrl(value) {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") &&
        url.hostname !== "search.google.com";
    } catch {
      return false;
    }
  }

  function urlsFromText(text) {
    const matches = (text || "").match(/https?:\/\/[^\s<>"']+/g) || [];
    return matches
      .map((candidate) => candidate.replace(/[),.;\]]+$/, ""))
      .filter(validPublicUrl);
  }

  function dedupe(values) {
    return [...new Set(values)];
  }

  function storageGet() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (result) => {
        const saved = result[STORAGE_KEY] || {};
        resolve({
          ...DEFAULT_STATE,
          ...saved,
          history: saved.history || {},
          log: Array.isArray(saved.log) ? saved.log : [],
          runs: Array.isArray(saved.runs) ? saved.runs : []
        });
      });
    });
  }

  function storageSet() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: state }, resolve);
    });
  }

  async function patchState(patch) {
    state = { ...state, ...patch };
    await storageSet();
    render();
  }

  async function addLog(status, url, message) {
    const entry = {
      at: new Date().toISOString(),
      status,
      url: url || null,
      message: message || ""
    };
    state.log = [entry, ...(state.log || [])].slice(0, 100);
    if (url && ["success", "already_indexed", "failed", "quota", "blocked"].includes(status)) {
      state.history = {
        ...(state.history || {}),
        [url]: { status, at: entry.at, message: entry.message }
      };
    }
    await storageSet();
    render();
  }

  function newRunId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function activeRun() {
    return (state.runs || []).find((run) => run.id === state.activeRunId) || null;
  }

  async function updateActiveRun(patch) {
    const runs = [...(state.runs || [])];
    const index = runs.findIndex((run) => run.id === state.activeRunId);
    if (index < 0) return;
    runs[index] = { ...runs[index], ...patch };
    state.runs = runs;
    await storageSet();
    render();
  }

  async function updateRunItem(url, status, message = "") {
    const runs = [...(state.runs || [])];
    const runIndex = runs.findIndex((run) => run.id === state.activeRunId);
    if (runIndex < 0) return;

    const run = { ...runs[runIndex] };
    const items = [...(run.items || [])];
    let itemIndex = items.findIndex((item) => item.url === url);
    if (itemIndex < 0) {
      items.push({
        url,
        status: "queued",
        message: "",
        startedAt: null,
        finishedAt: null,
        attempts: []
      });
      itemIndex = items.length - 1;
    }

    const now = new Date().toISOString();
    const existing = items[itemIndex];
    const attempts = [...(existing.attempts || [])];
    if (status === "working") {
      attempts.push({ status, message, startedAt: now, finishedAt: null });
    } else if (["success", "already_indexed", "failed", "cancelled"].includes(status)) {
      const openAttemptIndex = attempts.findLastIndex((attempt) => attempt.status === "working" && !attempt.finishedAt);
      const attemptStartedAt = openAttemptIndex >= 0 ? attempts[openAttemptIndex].startedAt : now;
      const completedAttempt = { status, message, startedAt: attemptStartedAt, finishedAt: now };
      if (openAttemptIndex >= 0) {
        attempts[openAttemptIndex] = { ...attempts[openAttemptIndex], ...completedAttempt };
      } else {
        attempts.push(completedAttempt);
      }
    }

    items[itemIndex] = {
      ...existing,
      status,
      message,
      startedAt: existing.startedAt || (status === "working" ? now : null),
      finishedAt: ["success", "already_indexed", "failed", "cancelled"].includes(status) ? now : null,
      attempts
    };
    run.items = items;
    runs[runIndex] = run;
    state.runs = runs;
    await storageSet();
    render();
  }

  async function cancelUnfinishedRunItems() {
    const run = activeRun();
    if (!run) return;
    const now = new Date().toISOString();
    const items = (run.items || []).map((item) => {
      if (!["queued", "working"].includes(item.status)) return item;
      const attempts = [...(item.attempts || [])];
      const openAttemptIndex = attempts.findLastIndex((attempt) => attempt.status === "working" && !attempt.finishedAt);
      if (openAttemptIndex >= 0) {
        attempts[openAttemptIndex] = {
          ...attempts[openAttemptIndex],
          status: "cancelled",
          message: "Queue cleared by user.",
          finishedAt: now
        };
      }
      return {
        ...item,
        status: "cancelled",
        message: "Queue cleared by user.",
        finishedAt: now,
        attempts
      };
    });
    await updateActiveRun({ status: "cancelled", finishedAt: now, items });
  }

  function attemptedRecently(url) {
    const item = state.history?.[url];
    if (!item?.at || !["success", "already_indexed"].includes(item.status)) return false;
    const age = Date.now() - new Date(item.at).getTime();
    return age < RETRY_AFTER_DAYS * 24 * 60 * 60 * 1000;
  }

  function pageText() {
    return normalize(document.body?.innerText || "");
  }

  function currentReportName() {
    const text = lower(pageText());
    return REPORT_NAMES.find((name) => text.includes(lower(name))) || null;
  }

  function onTargetReport() {
    return Boolean(currentReportName());
  }

  function extractReportUrls() {
    const urls = [];
    const rowSelectors = [
      "table tr",
      "[role='row']",
      "[role='gridcell']",
      "[role='cell']"
    ];

    for (const element of document.querySelectorAll(rowSelectors.join(","))) {
      if (!visible(element)) continue;
      urls.push(...urlsFromText(element.innerText || element.textContent || ""));
      for (const anchor of element.querySelectorAll("a[href]")) {
        const href = anchor.getAttribute("href");
        if (validPublicUrl(href)) urls.push(href);
        urls.push(...urlsFromText(anchor.innerText || ""));
      }
    }

    if (!urls.length) {
      for (const element of document.querySelectorAll("a, button, [role='button']")) {
        if (!visible(element)) continue;
        urls.push(...urlsFromText(element.innerText || element.textContent || ""));
      }
    }

    return dedupe(urls);
  }

  function allActionElements() {
    return [...document.querySelectorAll("button, a, [role='button']")].filter(visible);
  }

  function exactAction(names) {
    const wanted = names.map(lower);
    return allActionElements().find((element) => wanted.includes(lower(element.innerText || element.textContent)));
  }

  function hasExactVisibleText(names) {
    const wanted = names.map(lower);
    const selectors = "h1, h2, h3, h4, [role='heading'], [role='status'], [role='alert'], div, span";
    return [...document.querySelectorAll(selectors)].some((element) =>
      visible(element) && wanted.includes(lower(element.innerText || element.textContent))
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
    } else {
      const prototype = input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(input, value);
      else input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
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

  function blockerMessage() {
    const text = lower(pageText());
    const blockers = [
      ["quota exceeded", "Google's indexing-request quota was reached."],
      ["verify you are human", "Google asked for human verification."],
      ["unusual traffic", "Google detected unusual traffic."],
      ["captcha", "Google displayed a CAPTCHA."],
      ["url is not in property", "This URL does not belong to the open Search Console property."],
      ["you don't have permission", "This Google account does not have permission for the URL."],
      ["couldn't submit indexing request", "Google could not submit the indexing request."],
      ["could not submit indexing request", "Google could not submit the indexing request."],
      ["something went wrong", "Google reported that something went wrong."]
    ];
    const match = blockers.find(([needle]) => text.includes(needle));
    return match?.[1] || null;
  }

  function successMessage() {
    const text = lower(pageText());
    const successPhrases = [
      "indexing requested",
      "url was added to a priority crawl queue",
      "request submitted"
    ];
    return successPhrases.some((phrase) => text.includes(phrase))
      ? "Indexing request accepted by Google."
      : null;
  }

  function inspectionBusy() {
    const text = lower(pageText());
    return [
      "retrieving data from google index",
      "inspecting url",
      "testing if live url can be indexed",
      "testing whether live url can be indexed"
    ].some((phrase) => text.includes(phrase));
  }

  async function openInspection(url) {
    // Prefer the report's own URL -> INSPECT flow when the row is still available.
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

    // Fallback: the inspection box is present at the top of every GSC screen.
    const input = await waitFor(findInspectionInput, 15000, "the URL inspection box");
    setNativeValue(input, url);
    await sleep(250);
    pressEnter(input);
    await sleep(2500);
  }

  async function waitForInspectionResult() {
    return waitFor(() => {
      if (inspectionBusy()) return null;
      const blocked = blockerMessage();
      if (blocked) return { type: "blocked", message: blocked };
      if (hasExactVisibleText(["URL is on Google"])) {
        return { type: "already_indexed", message: "URL is already on Google; no indexing request was submitted." };
      }
      const requestButton = exactAction(["REQUEST INDEXING"]);
      if (actionEnabled(requestButton)) return { type: "ready", button: requestButton };
      return null;
    }, 180000, "Google's URL inspection result");
  }

  async function requestIndexing(button) {
    if (!button || !visible(button) || !actionEnabled(button)) {
      throw new Error("Request indexing button disappeared or became unavailable");
    }
    button.click();

    const outcome = await waitFor(() => {
      const success = successMessage();
      if (success) return { type: "success", message: success };
      const blocked = blockerMessage();
      if (blocked) return { type: "blocked", message: blocked };
      return null;
    }, 240000, "Google's indexing confirmation");

    const dismiss = exactAction(["GOT IT", "OK", "DISMISS", "CLOSE"]);
    if (dismiss) dismiss.click();
    return outcome;
  }

  async function processOne(url) {
    await patchState({ activeUrl: url });
    await updateRunItem(url, "working", "Opening URL inspection.");
    await addLog("working", url, "Opening URL inspection.");
    await openInspection(url);

    const result = await waitForInspectionResult();
    if (result.type !== "ready") return result;

    await addLog("working", url, "Inspection loaded; requesting indexing.");
    return requestIndexing(result.button);
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
        try {
          const outcome = await processOne(url);
          if (outcome.type === "already_indexed") {
            await updateRunItem(url, "already_indexed", outcome.message);
            state.queue = state.queue.slice(1);
            state.checkedThisRun += 1;
            state.activeUrl = null;
            await addLog("already_indexed", url, outcome.message);
            await updateActiveRun({
              checkedCount: state.checkedThisRun,
              requestsSubmitted: state.requestsThisRun
            });
            await storageSet();
            render();
            await sleep(750);
            continue;
          }

          if (outcome.type === "success") {
            await updateRunItem(url, "success", outcome.message);
            state.queue = state.queue.slice(1);
            state.checkedThisRun += 1;
            state.requestsThisRun += 1;
            state.completedThisRun = state.requestsThisRun;
            state.activeUrl = null;
            await addLog("success", url, outcome.message);
            await updateActiveRun({
              checkedCount: state.checkedThisRun,
              requestsSubmitted: state.requestsThisRun
            });
            await storageSet();
            render();
            await sleep(1500);
            continue;
          }

          const quota = /quota/i.test(outcome.message);
          state.checkedThisRun += 1;
          await updateRunItem(url, "failed", outcome.message);
          await addLog(quota ? "quota" : "blocked", url, outcome.message);
          await updateActiveRun({
            status: quota ? "stopped: quota" : "stopped: error",
            checkedCount: state.checkedThisRun,
            requestsSubmitted: state.requestsThisRun
          });
          await patchState({ running: false, paused: true, activeUrl: null });
          break;
        } catch (error) {
          if (error.message === "PAUSED") break;
          state.checkedThisRun += 1;
          await updateRunItem(url, "failed", error.message || "Unexpected extension error.");
          await addLog("failed", url, error.message || "Unexpected extension error.");
          await updateActiveRun({
            status: "stopped: error",
            checkedCount: state.checkedThisRun,
            requestsSubmitted: state.requestsThisRun
          });
          await patchState({ running: false, paused: true, activeUrl: null });
          break;
        }
      }

      const requestLimitReached = state.requestsThisRun >= state.runLimit;
      const candidatesExhausted = !state.queue.length;
      if (state.running && (requestLimitReached || candidatesExhausted)) {
        const finishedAt = new Date().toISOString();
        await updateActiveRun({
          status: requestLimitReached ? "completed" : "completed: candidates exhausted",
          finishedAt,
          checkedCount: state.checkedThisRun,
          requestsSubmitted: state.requestsThisRun
        });
        await patchState({ running: false, paused: false, queue: [], activeUrl: null });
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

  async function startBatch(limit = BATCH_LIMIT) {
    const reportName = currentReportName();
    if (!reportName) {
      await addLog("failed", null, `Open either “${REPORT_NAMES[0]}” or “${REPORT_NAMES[1]}” first.`);
      return;
    }

    const found = extractReportUrls();
    const eligible = found.filter((url) => !attemptedRecently(url));
    if (!eligible.length) {
      const explanation = found.length
        ? `The visible URLs were already attempted within ${RETRY_AFTER_DAYS} days.`
        : "No full URLs were found in the visible report rows.";
      await addLog("failed", null, explanation);
      return;
    }

    const startedAt = new Date().toISOString();
    const runId = newRunId();
    const run = {
      id: runId,
      reportName,
      reportUrl: location.href,
      requestLimit: limit,
      checkedCount: 0,
      requestsSubmitted: 0,
      status: "running",
      startedAt,
      finishedAt: null,
      items: []
    };

    await patchState({
      running: true,
      paused: false,
      queue: eligible,
      activeUrl: null,
      completedThisRun: 0,
      checkedThisRun: 0,
      requestsThisRun: 0,
      runLimit: limit,
      startedAt,
      reportUrl: location.href,
      activeRunId: runId,
      runs: [run, ...(state.runs || [])]
    });
    await addLog(
      "started",
      null,
      `Found ${eligible.length} candidate URL${eligible.length === 1 ? "" : "s"}; stopping after ${limit} actual indexing request${limit === 1 ? "" : "s"}.`
    );
    runWorker();
  }

  async function togglePause() {
    if (state.running && !state.paused) {
      await patchState({ paused: true, running: false });
      await updateActiveRun({ status: "paused" });
      await addLog("paused", state.activeUrl, "Paused by user.");
      return;
    }

    if (state.queue.length) {
      await patchState({ paused: false, running: true });
      await updateActiveRun({ status: "running" });
      await addLog("started", state.activeUrl, "Resumed queue.");
      runWorker();
    }
  }

  async function clearQueue() {
    await cancelUnfinishedRunItems();
    await patchState({
      running: false,
      paused: false,
      queue: [],
      activeUrl: null,
      completedThisRun: 0,
      checkedThisRun: 0,
      requestsThisRun: 0,
      runLimit: BATCH_LIMIT,
      startedAt: null,
      activeRunId: null
    });
    await addLog("cleared", null, "Queue cleared. Attempt history was kept.");
  }

  function statusLabel() {
    if (state.running) return `Working · ${state.requestsThisRun}/${state.runLimit} requests · ${state.checkedThisRun} checked`;
    if (state.paused && state.queue.length) return `Paused · ${state.requestsThisRun}/${state.runLimit} requests`;
    if (state.checkedThisRun) return `Last run · ${state.requestsThisRun} requests · ${state.checkedThisRun} checked`;
    return "Ready";
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }

  function runCounts(run) {
    const items = run.items || [];
    const attempts = items.flatMap((item) => item.attempts || []);
    return {
      success: attempts.filter((attempt) => attempt.status === "success").length,
      indexed: attempts.filter((attempt) => attempt.status === "already_indexed").length,
      failed: attempts.filter((attempt) => attempt.status === "failed").length,
      pending: items.filter((item) => ["queued", "working"].includes(item.status)).length
    };
  }

  function csvCell(value) {
    return `"${String(value ?? "").replaceAll('"', '""')}"`;
  }

  function exportRunLog() {
    const rows = [[
      "run_id",
      "run_started_at",
      "run_finished_at",
      "report",
      "run_status",
      "url",
      "request_status",
      "message",
      "request_started_at",
      "request_finished_at"
    ]];

    for (const run of state.runs || []) {
      for (const item of run.items || []) {
        const attempts = item.attempts?.length
          ? item.attempts
          : [{
              status: item.status,
              message: item.message,
              startedAt: item.startedAt,
              finishedAt: item.finishedAt
            }];
        for (const attempt of attempts) {
          rows.push([
            run.id,
            run.startedAt,
            run.finishedAt,
            run.reportName,
            run.status,
            item.url,
            attempt.status,
            attempt.message,
            attempt.startedAt,
            attempt.finishedAt
          ]);
        }
      }
    }

    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
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

  function render() {
    if (!ui) return;
    const recent = (state.log || []).slice(0, 5);
    const recentRuns = (state.runs || []).slice(0, 5);
    const reportName = currentReportName();
    const foundCount = onTargetReport() ? extractReportUrls().length : 0;
    ui.panel.innerHTML = `
      <div class="head">
        <div>
          <div class="title">GSC Indexing Helper</div>
          <div class="status">${escapeHtml(statusLabel())}</div>
        </div>
        <button class="icon" data-action="collapse" title="Minimize">−</button>
      </div>
      <div class="body">
        <div class="report ${onTargetReport() ? "ok" : "warn"}">
          ${onTargetReport()
            ? `${foundCount} URL${foundCount === 1 ? "" : "s"} visible in “${escapeHtml(reportName)}”`
            : `Open a Crawled or Discovered “currently not indexed” detail report`}
        </div>
        ${state.activeUrl ? `<div class="active"><strong>Current</strong><span>${escapeHtml(state.activeUrl)}</span></div>` : ""}
        <div class="buttons">
          <button data-action="start-one" ${state.running || state.queue.length ? "disabled" : ""}>Submit one</button>
          <button class="primary" data-action="start" ${state.running || state.queue.length ? "disabled" : ""}>Run first 10</button>
          <button data-action="pause" ${!state.queue.length ? "disabled" : ""}>${state.running ? "Pause" : "Resume"}</button>
          <button data-action="clear" ${!state.queue.length && !state.activeUrl ? "disabled" : ""}>Clear</button>
        </div>
        <div class="note">Only a successful Request indexing submission counts toward 10. “URL is on Google” counts as 0 and moves on. Set the report to show 25–50 rows so there are enough candidates. Stops on quota, verification, permission errors, or an unexpected screen.</div>
        <div class="log">
          ${recent.length ? recent.map((item) => `
            <div class="log-row ${escapeHtml(item.status)}">
              <span>${escapeHtml(item.status)}</span>
              <div title="${escapeHtml(item.url || item.message)}">${escapeHtml(item.url || item.message)}</div>
            </div>`).join("") : `<div class="empty">No activity yet.</div>`}
        </div>
        <div class="history-head">
          <strong>Permanent run log</strong>
          <button class="small" data-action="export" ${!recentRuns.length ? "disabled" : ""}>Export CSV</button>
        </div>
        <div class="runs">
          ${recentRuns.length ? recentRuns.map((run) => {
            const counts = runCounts(run);
            return `
              <details class="run">
                <summary>
                  <span>${escapeHtml(formatDate(run.startedAt))}</span>
                  <span class="counts">${counts.success} requested · ${counts.indexed} indexed · ${counts.failed} failed${counts.pending ? ` · ${counts.pending} pending` : ""}</span>
                </summary>
                <div class="run-meta">${escapeHtml(run.reportName)} · ${escapeHtml(run.status)}</div>
                ${(run.items || []).flatMap((item) => {
                  const attempts = item.attempts?.length ? item.attempts : [{ status: item.status, message: item.message }];
                  return attempts.map((attempt) => `
                    <div class="run-item ${escapeHtml(attempt.status)}">
                      <span>${escapeHtml(attempt.status)}</span>
                      <div title="${escapeHtml(attempt.message || item.url)}">${escapeHtml(item.url)}</div>
                    </div>`);
                }).join("")}
              </details>`;
          }).join("") : `<div class="empty">No completed or attempted runs yet.</div>`}
        </div>
      </div>`;
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
        button.textContent = panel.classList.contains("collapsed") ? "+" : "−";
      }
    });
    render();
  }

  async function init() {
    state = await storageGet();
    // Never resume a click sequence merely because Chrome reopened a tab.
    if (state.running) {
      state.running = false;
      state.paused = Boolean(state.queue.length);
      const runIndex = (state.runs || []).findIndex((run) => run.id === state.activeRunId);
      if (runIndex >= 0) state.runs[runIndex] = { ...state.runs[runIndex], status: "paused: browser restarted" };
      await storageSet();
    }
    mount();

    const observer = new MutationObserver(() => {
      clearTimeout(observer.renderTimer);
      observer.renderTimer = setTimeout(render, 400);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  init().catch((error) => console.error("GSC Indexing Helper failed to initialize", error));
})();
