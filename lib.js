/**
 * Pure helper functions for the GSC Indexing Helper.
 *
 * This file contains no DOM access and no Chrome API calls. Every function
 * takes its input as an argument and returns a value. This makes the rules
 * testable with `npm test` outside the browser.
 *
 * The file loads before content.js as a content script. It also loads in
 * Node for the tests.
 */
(function (root) {
  "use strict";

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  /** The maximum number of accepted indexing requests in one run. */
  const BATCH_LIMIT = 10;

  /** Skip a URL for this many days after a successful request. */
  const RETRY_AFTER_DAYS = 14;

  /** Skip a URL for this many days after a failure. */
  const FAILED_RETRY_AFTER_DAYS = 3;

  /** Stop the run after this many failures in a row. */
  const MAX_CONSECUTIVE_FAILURES = 3;

  /** Keep this many runs in the permanent log. */
  const MAX_RUNS = 200;

  /** Drop attempt history that is older than this many days. */
  const HISTORY_MAX_AGE_DAYS = 90;

  /** The two Search Console reports this extension supports. */
  const REPORT_NAMES = [
    "Crawled - currently not indexed",
    "Discovered - currently not indexed"
  ];

  /**
   * Text that means the extension must not click again.
   *
   * `hard` marks a problem with the account or the browser session. The run
   * stops. A soft blocker is a problem with one URL. The run records the
   * failure and moves to the next URL.
   */
  const BLOCKERS = [
    { needle: "quota exceeded", hard: true, message: "Google's indexing-request quota was reached." },
    { needle: "verify you are human", hard: true, message: "Google asked for human verification." },
    { needle: "unusual traffic", hard: true, message: "Google detected unusual traffic." },
    { needle: "captcha", hard: true, message: "Google displayed a CAPTCHA." },
    { needle: "url is not in property", hard: false, message: "This URL does not belong to the open Search Console property." },
    { needle: "you don't have permission", hard: false, message: "This Google account does not have permission for the URL." },
    { needle: "couldn't submit indexing request", hard: false, message: "Google could not submit the indexing request." },
    { needle: "could not submit indexing request", hard: false, message: "Google could not submit the indexing request." },
    { needle: "something went wrong", hard: false, message: "Google reported that something went wrong." }
  ];

  /** Text that means Google accepted the indexing request. */
  const SUCCESS_PHRASES = [
    "indexing requested",
    "url was added to a priority crawl queue",
    "request submitted"
  ];

  /** Text that means Google is still working. */
  const BUSY_PHRASES = [
    "retrieving data from google index",
    "inspecting url",
    "testing if live url can be indexed",
    "testing whether live url can be indexed"
  ];

  /** Item and attempt statuses that end an attempt. */
  const TERMINAL_STATUSES = ["success", "already_indexed", "failed", "cancelled"];

  const DAY_MS = 24 * 60 * 60 * 1000;

  // ---------------------------------------------------------------------------
  // Text helpers
  // ---------------------------------------------------------------------------

  /** Replace unusual dashes and collapse whitespace. */
  function normalize(value) {
    return (value || "")
      .replace(/[‐-―−]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Normalize the text and make it lower case. */
  function lower(value) {
    return normalize(value).toLowerCase();
  }

  /** Escape the five HTML characters that can break the panel markup. */
  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // ---------------------------------------------------------------------------
  // URL helpers
  // ---------------------------------------------------------------------------

  /** Return true if the value is an http or https URL outside Search Console. */
  function validPublicUrl(value) {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") &&
        url.hostname !== "search.google.com";
    } catch {
      return false;
    }
  }

  /** Find every public URL inside a block of text. */
  function urlsFromText(text) {
    const matches = (text || "").match(/https?:\/\/[^\s<>"']+/g) || [];
    return matches
      .map((candidate) => candidate.replace(/[),.;\]]+$/, ""))
      .filter(validPublicUrl);
  }

  /** Remove duplicate values and keep the original order. */
  function dedupe(values) {
    return [...new Set(values)];
  }

  // ---------------------------------------------------------------------------
  // Report and page-text rules
  // ---------------------------------------------------------------------------

  /** Return the supported report name that the page text contains. */
  function matchReportName(pageText, reportNames = REPORT_NAMES) {
    const text = lower(pageText);
    return reportNames.find((name) => text.includes(lower(name))) || null;
  }

  /** Return true if Google is still loading an inspection result. */
  function isInspectionBusy(pageText) {
    const text = lower(pageText);
    return BUSY_PHRASES.some((phrase) => text.includes(phrase));
  }

  /**
   * Return the blocker that the page text contains.
   *
   * @returns {{message: string, hard: boolean}|null}
   */
  function classifyBlocker(pageText) {
    const text = lower(pageText);
    const match = BLOCKERS.find((blocker) => text.includes(blocker.needle));
    if (!match) return null;
    return { message: match.message, hard: match.hard };
  }

  /**
   * Return a success message only when the text is new.
   *
   * Google leaves an old confirmation toast on the page while it fades out.
   * The caller records the page text before it clicks. This function ignores
   * any phrase that was already present in that earlier text.
   */
  function findNewSuccess(pageText, textBeforeClick) {
    const text = lower(pageText);
    const before = lower(textBeforeClick);
    const isNew = SUCCESS_PHRASES.some((phrase) => text.includes(phrase) && !before.includes(phrase));
    return isNew ? "Indexing request accepted by Google." : null;
  }

  // ---------------------------------------------------------------------------
  // Attempt history rules
  // ---------------------------------------------------------------------------

  /**
   * Decide whether to skip a URL because of an earlier attempt.
   *
   * A successful or already-indexed URL waits 14 days. A failed URL waits 3
   * days. The shorter wait stops one broken URL from blocking every run,
   * because the run would otherwise meet the same URL first each day.
   *
   * @returns {string|null} The reason to skip, or null to process the URL.
   */
  function skipReason(history, url, now = Date.now()) {
    const item = (history || {})[url];
    if (!item || !item.at) return null;

    const at = new Date(item.at).getTime();
    if (Number.isNaN(at)) return null;
    const ageDays = (now - at) / DAY_MS;

    if (item.status === "success" || item.status === "already_indexed") {
      if (ageDays < RETRY_AFTER_DAYS) {
        return `Attempted ${Math.floor(ageDays)} day(s) ago; waiting ${RETRY_AFTER_DAYS} days.`;
      }
      return null;
    }

    if (item.status === "failed") {
      if (ageDays < FAILED_RETRY_AFTER_DAYS) {
        return `Failed ${Math.floor(ageDays)} day(s) ago; waiting ${FAILED_RETRY_AFTER_DAYS} days.`;
      }
      return null;
    }

    return null;
  }

  /** Remove history entries that are older than the retention period. */
  function pruneHistory(history, now = Date.now(), maxAgeDays = HISTORY_MAX_AGE_DAYS) {
    const kept = {};
    for (const [url, item] of Object.entries(history || {})) {
      const at = new Date(item && item.at).getTime();
      if (Number.isNaN(at)) continue;
      if (now - at <= maxAgeDays * DAY_MS) kept[url] = item;
    }
    return kept;
  }

  /** Keep the newest runs and return the ids of the runs that were dropped. */
  function pruneRunIndex(runIndex, maxRuns = MAX_RUNS) {
    const runs = Array.isArray(runIndex) ? runIndex : [];
    if (runs.length <= maxRuns) return { kept: runs, dropped: [] };
    return {
      kept: runs.slice(0, maxRuns),
      dropped: runs.slice(maxRuns).map((run) => run.id)
    };
  }

  // ---------------------------------------------------------------------------
  // Run counts and CSV export
  // ---------------------------------------------------------------------------

  /** Count the outcomes in one run's items. */
  function countRunItems(items) {
    const list = Array.isArray(items) ? items : [];
    const attempts = list.flatMap((item) => item.attempts || []);
    return {
      success: attempts.filter((attempt) => attempt.status === "success").length,
      indexed: attempts.filter((attempt) => attempt.status === "already_indexed").length,
      failed: attempts.filter((attempt) => attempt.status === "failed").length,
      pending: list.filter((item) => ["queued", "working"].includes(item.status)).length
    };
  }

  /** Wrap a value in quotes for a CSV cell. */
  function csvCell(value) {
    return `"${String(value === null || value === undefined ? "" : value).replaceAll('"', '""')}"`;
  }

  const CSV_HEADER = [
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
  ];

  /**
   * Build the complete CSV text for the run log.
   *
   * @param {Array} runs Runs that each carry an `items` array.
   */
  function buildCsv(runs) {
    const rows = [CSV_HEADER];
    for (const run of runs || []) {
      for (const item of run.items || []) {
        const attempts = (item.attempts && item.attempts.length)
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
    return rows.map((row) => row.map(csvCell).join(",")).join("\n");
  }

  // ---------------------------------------------------------------------------

  const lib = {
    BATCH_LIMIT,
    RETRY_AFTER_DAYS,
    FAILED_RETRY_AFTER_DAYS,
    MAX_CONSECUTIVE_FAILURES,
    MAX_RUNS,
    HISTORY_MAX_AGE_DAYS,
    REPORT_NAMES,
    BLOCKERS,
    SUCCESS_PHRASES,
    BUSY_PHRASES,
    TERMINAL_STATUSES,
    DAY_MS,
    normalize,
    lower,
    escapeHtml,
    validPublicUrl,
    urlsFromText,
    dedupe,
    matchReportName,
    isInspectionBusy,
    classifyBlocker,
    findNewSuccess,
    skipReason,
    pruneHistory,
    pruneRunIndex,
    countRunItems,
    csvCell,
    CSV_HEADER,
    buildCsv
  };

  root.GSC_LIB = lib;
  if (typeof module !== "undefined" && module.exports) module.exports = lib;
})(typeof globalThis !== "undefined" ? globalThis : this);
