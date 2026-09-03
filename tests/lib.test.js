"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../lib.js");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-03T12:00:00.000Z");
const daysAgo = (days) => new Date(NOW - days * DAY).toISOString();

test("normalize collapses whitespace and unifies dashes", () => {
  assert.equal(lib.normalize("  Crawled \n– currently  not indexed "), "Crawled - currently not indexed");
  assert.equal(lib.normalize("a−b"), "a-b");
  assert.equal(lib.normalize(null), "");
});

test("matchReportName finds both supported reports", () => {
  assert.equal(
    lib.matchReportName("Page indexing > Crawled – currently not indexed"),
    "Crawled - currently not indexed"
  );
  assert.equal(
    lib.matchReportName("DISCOVERED - CURRENTLY NOT INDEXED"),
    "Discovered - currently not indexed"
  );
  assert.equal(lib.matchReportName("Performance report"), null);
});

test("validPublicUrl accepts site URLs and rejects Search Console URLs", () => {
  assert.equal(lib.validPublicUrl("https://example.com/page"), true);
  assert.equal(lib.validPublicUrl("http://example.com"), true);
  assert.equal(lib.validPublicUrl("https://search.google.com/search-console/x"), false);
  assert.equal(lib.validPublicUrl("javascript:alert(1)"), false);
  assert.equal(lib.validPublicUrl("not a url"), false);
});

test("urlsFromText extracts URLs and strips trailing punctuation", () => {
  assert.deepEqual(
    lib.urlsFromText("See https://example.com/a, and https://example.com/b."),
    ["https://example.com/a", "https://example.com/b"]
  );
  assert.deepEqual(lib.urlsFromText("no urls here"), []);
});

test("dedupe keeps the first occurrence and the order", () => {
  assert.deepEqual(lib.dedupe(["a", "b", "a", "c"]), ["a", "b", "c"]);
});

test("escapeHtml escapes every dangerous character", () => {
  assert.equal(
    lib.escapeHtml(`<img src=x onerror="alert('&')">`),
    "&lt;img src=x onerror=&quot;alert(&#039;&amp;&#039;)&quot;&gt;"
  );
});

test("classifyBlocker marks quota and CAPTCHA as hard stops", () => {
  assert.deepEqual(lib.classifyBlocker("Daily quota exceeded"), {
    message: "Google's indexing-request quota was reached.",
    hard: true
  });
  assert.equal(lib.classifyBlocker("Please verify you are human").hard, true);
  assert.equal(lib.classifyBlocker("We detected unusual traffic").hard, true);
});

test("classifyBlocker marks single-URL problems as soft stops", () => {
  assert.equal(lib.classifyBlocker("URL is not in property").hard, false);
  assert.equal(lib.classifyBlocker("You don't have permission").hard, false);
  assert.equal(lib.classifyBlocker("Something went wrong").hard, false);
});

test("classifyBlocker returns null for a normal page", () => {
  assert.equal(lib.classifyBlocker("URL is on Google. Coverage. Enhancements."), null);
});

test("findNewSuccess accepts a confirmation that was not on the page before", () => {
  assert.equal(
    lib.findNewSuccess("Indexing requested", "Request indexing"),
    "Indexing request accepted by Google."
  );
});

test("findNewSuccess rejects a confirmation left over from the last URL", () => {
  assert.equal(lib.findNewSuccess("Indexing requested", "Indexing requested"), null);
});

test("isInspectionBusy detects the loading states", () => {
  assert.equal(lib.isInspectionBusy("Retrieving data from Google index"), true);
  assert.equal(lib.isInspectionBusy("URL is on Google"), false);
});

test("skipReason waits 14 days after a success", () => {
  const history = { "https://example.com/a": { status: "success", at: daysAgo(5) } };
  assert.ok(lib.skipReason(history, "https://example.com/a", NOW));
});

test("skipReason allows a retry after 14 days", () => {
  const history = { "https://example.com/a": { status: "success", at: daysAgo(15) } };
  assert.equal(lib.skipReason(history, "https://example.com/a", NOW), null);
});

test("skipReason waits only 3 days after a failure", () => {
  const history = { "https://example.com/a": { status: "failed", at: daysAgo(1) } };
  assert.ok(lib.skipReason(history, "https://example.com/a", NOW));
});

test("skipReason retries a failed URL after 3 days", () => {
  const history = { "https://example.com/a": { status: "failed", at: daysAgo(4) } };
  assert.equal(lib.skipReason(history, "https://example.com/a", NOW), null);
});

test("skipReason processes a URL that has no history", () => {
  assert.equal(lib.skipReason({}, "https://example.com/new", NOW), null);
  assert.equal(lib.skipReason(null, "https://example.com/new", NOW), null);
});

test("skipReason ignores an unreadable timestamp", () => {
  const history = { "https://example.com/a": { status: "success", at: "not-a-date" } };
  assert.equal(lib.skipReason(history, "https://example.com/a", NOW), null);
});

test("pruneHistory drops entries older than 90 days", () => {
  const history = {
    keep: { status: "success", at: daysAgo(10) },
    drop: { status: "success", at: daysAgo(200) },
    broken: { status: "success", at: null }
  };
  assert.deepEqual(Object.keys(lib.pruneHistory(history, NOW)), ["keep"]);
});

test("pruneRunIndex keeps the newest runs and reports the dropped ids", () => {
  const runs = Array.from({ length: 5 }, (unused, index) => ({ id: `run-${index}` }));
  const result = lib.pruneRunIndex(runs, 3);
  assert.equal(result.kept.length, 3);
  assert.deepEqual(result.dropped, ["run-3", "run-4"]);
});

test("pruneRunIndex keeps everything when the list is short", () => {
  const result = lib.pruneRunIndex([{ id: "a" }], 200);
  assert.equal(result.kept.length, 1);
  assert.deepEqual(result.dropped, []);
});

test("countRunItems counts attempts by outcome", () => {
  const items = [
    { status: "success", attempts: [{ status: "failed" }, { status: "success" }] },
    { status: "already_indexed", attempts: [{ status: "already_indexed" }] },
    { status: "working", attempts: [{ status: "working" }] }
  ];
  assert.deepEqual(lib.countRunItems(items), { success: 1, indexed: 1, failed: 1, pending: 1 });
});

test("csvCell escapes an embedded quote", () => {
  assert.equal(lib.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(lib.csvCell(null), '""');
});

test("buildCsv writes a header row and one row for every attempt", () => {
  const csv = lib.buildCsv([{
    id: "run-1",
    startedAt: "2026-09-03T10:00:00.000Z",
    finishedAt: "2026-09-03T10:05:00.000Z",
    reportName: "Crawled - currently not indexed",
    status: "completed",
    items: [{
      url: "https://example.com/a",
      status: "success",
      attempts: [
        { status: "failed", message: "Timed out", startedAt: "x", finishedAt: "y" },
        { status: "success", message: "Accepted", startedAt: "y", finishedAt: "z" }
      ]
    }]
  }]);
  const lines = csv.split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('"run_id"'));
  assert.ok(lines[1].includes('"failed"'));
  assert.ok(lines[2].includes('"success"'));
});

test("buildCsv falls back to the item status when there are no attempts", () => {
  const csv = lib.buildCsv([{ id: "r", items: [{ url: "https://example.com", status: "cancelled", message: "m" }] }]);
  assert.equal(csv.split("\n").length, 2);
  assert.ok(csv.includes('"cancelled"'));
});
