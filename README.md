# GSC Indexing Helper

A deliberately small Chrome extension that processes up to 10 visible URLs from either of these Google Search Console reports:

- **Crawled - currently not indexed**
- **Discovered - currently not indexed**

## What it does

1. Reads the visible URLs in the open report.
2. Skips a URL that Google already accepted or already indexed in the previous 14 days.
3. Skips a URL that failed in the previous 3 days.
4. Opens URL Inspection using the report's own **INSPECT** action when available.
5. Falls back to the global **Inspect any URL** box if the report action is unavailable.
6. Clicks **REQUEST INDEXING** and waits for Google's confirmation.
7. If inspection says **URL is on Google**, records it as already indexed, consumes zero of the 10-request limit, and immediately checks the next URL.
8. Continues until it has made 10 accepted **Request indexing** submissions or runs out of visible report candidates.
9. Records a problem with one URL, then moves to the next URL.
10. Stops the whole run if it sees a quota message, a human-verification screen, a CAPTCHA, or 3 failures in a row.
11. Permanently records each run and every checked URL's outcome in Chrome's local extension storage.
12. Exports the complete run history as a CSV file.

The extension does not bypass CAPTCHA, rotate accounts, evade quotas, call undocumented Google endpoints, or run in the background. Every batch must be started by you while Search Console is open.

## Install

1. Unzip the package.
2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the unzipped `gsc-indexing-helper` folder.

### Updating an existing installation

Replace the files inside the same `gsc-indexing-helper` folder you originally loaded, then click **Reload** on the extension's card at `chrome://extensions`. Keeping the same installed folder preserves its stored history.

Version 0.4.0 changes how the extension stores its data. The first run after the update moves your existing history into the new layout. You do not need to do anything.

## Use

1. Open the relevant property in Google Search Console.
2. Go to **Page indexing**.
3. Open either the **Crawled - currently not indexed** or **Discovered - currently not indexed** detail report.
4. Set **Rows per page** to 25 or 50 so the extension has replacement candidates when some URLs are already indexed.
5. Wait until the URL table appears.
6. On the first use, click **Submit one** and confirm that the complete workflow succeeds.
7. Then click **Run first 10** for normal daily processing.
8. Leave that Search Console tab open until the batch finishes or pauses.

Do not click around in the Search Console tab while a batch is running. You can press **Pause** at any time.

## When the extension stops

The extension separates a problem with one URL from a problem with your session.

**One URL.** Examples are "URL is not in property", "Something went wrong", and a timeout. The extension records the failure, skips that URL for 3 days, and continues with the next URL. The 3-day wait stops one broken URL from blocking every later run, because the report shows the same URL first each day.

**Your session.** Examples are a quota message, a human-verification screen, and a CAPTCHA. The extension stops the whole run and keeps the URL in the queue. The attempt history does not change, because the URL is not at fault. Press **Resume** after you fix the problem.

**Three failures in a row.** The extension stops the run. Open Search Console yourself and check what changed.

## Run log

The panel shows the five most recent runs. Expand a run to see which URLs were already indexed, which received an accepted indexing request, and which failed. Click **Export CSV** to download the complete history.

The extension keeps the 200 most recent runs. It keeps the attempt history for 90 days. It removes older records to keep Chrome's storage small and fast.

## What the report status means

**Crawled - currently not indexed** is a current status, not a permanent rejection. This is common on a new site: Google can discover the full sitemap, crawl its URLs, and then add those pages to the index gradually over a much longer period. This helper is designed to speed up the repetitive manual workflow of putting 10 of those recognized URLs per day through **Request indexing**.

Google can still decide when or whether to index a submitted URL, so an accepted request is not a guarantee of inclusion.

## If Google changes Search Console

The extension uses visible labels rather than Google's generated CSS class names, which makes it less fragile, but Search Console can still change. If the helper cannot identify a required screen, it pauses before making another click. Reload the report and try once more; if it still pauses, the extension's recognition rules need an update.

## Privacy

The extension only runs on `https://search.google.com/search-console/*`. Queue state, attempt history, and the permanent run log stay in Chrome's local extension storage. It sends no data to any server.

## Development

The extension needs no build step. Chrome loads the source files directly.

| File | Purpose |
| --- | --- |
| `manifest.json` | The Chrome extension manifest. |
| `lib.js` | Pure rules with no DOM access. Loads before `content.js`. |
| `content.js` | The panel, the page reading, and the indexing workflow. |
| `styles.css` | The position of the panel host element. |
| `tests/lib.test.js` | Unit tests for the rules in `lib.js`. |
| `tests/extension.test.js` | Tests that load the extension into a simulated Search Console page. |

Install the development tools and run the checks:

```
npm install
npm run lint
npm test
npm run check
```

`npm test` needs Node 20 or later. The tests use the built-in Node test runner and jsdom. They do not need Chrome.
