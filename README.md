# GSC Indexing Helper

A deliberately small Chrome extension that processes up to 10 visible URLs from either of these Google Search Console reports:

- **Crawled - currently not indexed**
- **Discovered - currently not indexed**

## What it does

1. Reads the visible URLs in the open report.
2. Skips URLs attempted within the previous 14 days.
3. Opens URL Inspection using the report's own **INSPECT** action when available.
4. Falls back to the global **Inspect any URL** box if the report action is unavailable.
5. Clicks **REQUEST INDEXING** and waits for Google's confirmation.
6. If inspection says **URL is on Google**, records it as already indexed, consumes zero of the 10-request limit, and immediately checks the next URL.
7. Continues until it has made 10 successful **Request indexing** submissions or runs out of visible report candidates.
8. Stops rather than continuing if it sees a quota message, human-verification screen, permission problem, unexpected error, or interface it cannot recognize.
9. Permanently records each run and every checked URL's outcome in Chrome's local extension storage.
10. Exports the complete run history as a CSV file.

The extension does not bypass CAPTCHA, rotate accounts, evade quotas, call undocumented Google endpoints, or run in the background. Every batch must be started by you while Search Console is open.

## Install

1. Unzip the package.
2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the unzipped `gsc-indexing-helper` folder.

### Updating an existing installation

Replace the files inside the same `gsc-indexing-helper` folder you originally loaded, then click **Reload** on the extension's card at `chrome://extensions`. Keeping the same installed folder preserves its stored history.

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

## Run log

The panel shows the five most recent runs. Expand a run to see which URLs were already indexed, which received a successful indexing request, and which failed. Click **Export CSV** to download the complete history. The full log persists across Chrome restarts and extension updates until you uninstall the extension or clear its stored site data.

## What the report status means

**Crawled - currently not indexed** is a current status, not a permanent rejection. This is common on a new site: Google can discover the full sitemap, crawl its URLs, and then add those pages to the index gradually over a much longer period. This helper is designed to speed up the repetitive manual workflow of putting 10 of those recognized URLs per day through **Request indexing**.

Google can still decide when or whether to index a submitted URL, so an accepted request is not a guarantee of inclusion.

## If Google changes Search Console

The extension uses visible labels rather than Google's generated CSS class names, which makes it less fragile, but Search Console can still change. If the helper cannot identify a required screen, it pauses before making another click. Reload the report and try once more; if it still pauses, the extension's recognition rules need an update.

## Privacy

The extension only runs on `https://search.google.com/search-console/*`. Queue state, attempt history, and the permanent run log stay in Chrome's local extension storage. It sends no data to any server.
