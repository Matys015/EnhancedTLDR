# TLDR Newsletter Processor

A Google Apps Script automation that reads your daily TLDR newsletter emails,
scrapes each article, generates AI summaries via OpenRouter, and delivers
a formatted Google Docs report to your inbox every morning.

## What it does

Every weekday at 2:00 AM the pipeline:

1. Searches Gmail for yesterday's TLDR newsletters
2. Extracts article links and metadata
3. Scrapes each article's content
4. Sends the text to an LLM via OpenRouter API
5. Compiles all summaries into a formatted Google Docs document
6. Saves the document to Google Drive under `TLDR/YYYY/month/DD/`
7. Sends you an email with a direct link to the report

## Supported newsletters

| Newsletter | Topic |
|---|---|
| TLDR | General technology |
| TLDR Dev | Software development |
| TLDR DevOps | DevOps, cloud, infrastructure |
| TLDR IT | IT management, security |
| TLDR AI | Artificial intelligence |

## Article types

| Type | Detected by | AI output |
|---|---|---|
| `article` | `(N minute read)`, up to 20 min | Full summary, 3–6 paragraphs |
| `long_read` | `(N minute read)`, over 20 min | Short preview, 3–5 sentences |
| `github` | `(GitHub Repo)` | Project description: purpose, features, stack |
| `website` | `(Website)` | Tool/service description: purpose, features, audience |

## Architecture

Processing one article per trigger interval (default: 5 min) avoids
Google Apps Script's 6-minute execution limit. State is persisted in
Script Properties between executions.

startPipeline() → runs once at 02:00, collects articles
↓
runNextStep() → runs every 5 min, processes one article per call
↓
finalizePipeline() → creates Google Doc, sends email, cleans up

## Tech stack

- **Runtime:** Google Apps Script
- **AI:** OpenRouter API (model configurable, free models supported)
- **Storage:** Google Drive + Google Docs
- **Notifications:** Gmail

## Setup

### 1. Create the script

1. Go to [script.google.com](https://script.google.com) and create a new project
2. Paste the contents of `tldr-processor.js`
3. Save the project

### 2. Add your OpenRouter API key

In the Apps Script editor:
**Project Settings → Script Properties → Add property**

| Property | Value |
|---|---|
| `OPENROUTER_API_KEY` | `sk-or-your-key-here` |

Get a free API key at [openrouter.ai](https://openrouter.ai).

### 3. Authorize and test

Run `testDriveOnly()` first to grant permissions and verify
that Drive, Docs, and Gmail all work correctly.

Then run `testSingleArticle()` to verify the full pipeline
including AI summarization.

### 4. Activate the daily trigger

Run `setupDailyTrigger()` once. The pipeline will start automatically
every weekday at 02:00 in your script's timezone.

## Configuration

All settings are in the `CONFIG` object at the top of the script.

| Parameter | Default | Description |
|---|---|---|
| `OPENROUTER_MODEL` | `openrouter/owl-alpha` | LLM model identifier |
| `LONG_READ_THRESHOLD_MINUTES` | `20` | Articles above this threshold get a preview instead of a full summary |
| `MAX_TEXT_LENGTH` | `40000` | Characters sent to the model per article |
| `MAX_TOTAL_ARTICLES` | `70` | Hard cap on articles processed per day |
| `MAX_CONSECUTIVE_ERRORS` | `5` | Consecutive API failures before early termination |
| `STEP_TRIGGER_MINUTES` | `5` | Interval between article processing steps |
| `DRIVE_ROOT_FOLDER` | `TLDR` | Root folder name in Google Drive |

## Diagnostic functions

| Function | Purpose |
|---|---|
| `setupDailyTrigger()` | Create or recreate the 03:00 daily trigger |
| `testDriveOnly()` | Test Drive/Docs/Gmail without AI |
| `testSingleArticle()` | Full end-to-end test on one article |
| `showArticles()` | List all articles found in yesterday's emails |
| `showState()` | Show current pipeline progress |
| `emergencyReset()` | Stop a running pipeline and clear all state |

## Output

Each day's report is saved to: Google Drive

The notification email contains statistics (articles processed,
summaries generated, unavailable) and a single button linking
to the Google Doc.

## Notes

- Articles behind paywalls or requiring JavaScript are marked with
  a warning and skipped gracefully
- The AI prompt instructs the model to write in Polish
- Summaries are plain prose — Markdown is stripped before writing to the Doc
- Free OpenRouter models are sufficient for daily use

## License

MIT

