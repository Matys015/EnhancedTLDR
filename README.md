# TLDR Newsletter Processor

A Google Apps Script automation that reads your daily TLDR newsletter emails,
scrapes each article, generates AI summaries via OpenRouter, and delivers
a formatted Google Docs report to your inbox every morning.

## What it does

Every weekday at midnight the pipeline:

1. Searches Gmail for yesterday's TLDR newsletters
2. Extracts article links, metadata, and inline descriptions
3. Deduplicates articles appearing across multiple newsletters
4. Scrapes each article's content
5. Sends the text to an LLM via OpenRouter API for summarization in Polish
6. Falls back to translating the newsletter's inline description
   when a page is inaccessible (paywall, JavaScript-only, 403)
7. Compiles all results into a formatted Google Docs document
8. Saves the document to Google Drive under `TLDR/YYYY/month/DD/`
9. Sends you an email with a direct link to the report

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
| `long_read` | `(N minute read)`, over 20 min | Short teaser, 3–5 sentences |
| `github` | `(GitHub Repo)` | Project description: purpose, features, stack |
| `website` | `(Website)` | Tool/service description: purpose, features, audience |

## Architecture

Processing one article per trigger interval (default: 5 min) avoids
Google Apps Script's 6-minute execution limit. State is persisted in
Script Properties between executions.

startPipeline() — runs once at 00:00, collects and deduplicates articles
↓
runNextStep() — runs every 5 min, processes one article per call
↓
finalizePipeline() — creates Google Doc, sends email, cleans up


### Fallback summarization

If scraping a page fails, the pipeline checks whether the newsletter's
inline description (snippet) was captured during parsing. If so, it sends
that snippet to the LLM for translation into Polish instead of returning
an error. The document marks such entries clearly so the source is transparent.

### Retry logic

Transient API errors (429, 503, etc.) trigger automatic re-queuing with
exponential backoff. On the final attempt the pipeline switches to the
configured backup model. After exhausting all attempts the article is
recorded with an error message and processing continues.

### Deduplication

Articles covering the same topic across multiple newsletters are deduplicated
using token-level similarity (Jaccard coefficient + containment ratio).
Only the first occurrence is processed.

## Tech stack

- **Runtime:** Google Apps Script
- **AI:** OpenRouter API (configurable model, free models supported)
- **Storage:** Google Drive + Google Docs
- **Notifications:** Gmail

## Setup

### 1. Create the script

1. Go to [script.google.com](https://script.google.com) and create a new project
2. Paste the contents of `tldr-processor.js`
3. Save the project

### 2. Set the timezone

**Project Settings → General → Timezone → Europe/Warsaw** (or your local zone).
This affects when the daily trigger fires.

### 3. Add your OpenRouter API key

**Project Settings → Script Properties → Add property**

| Property | Value |
|---|---|
| `OPENROUTER_API_KEY` | `sk-or-your-key-here` |

Get a free API key at [openrouter.ai](https://openrouter.ai).

### 4. Authorize and test infrastructure

Run `testDriveOnly()` to grant permissions and verify that Drive, Docs,
and Gmail all work correctly before touching the AI layer.

### 5. Test the full pipeline

Run `testSingleArticle()` to verify end-to-end flow including AI summarization.
Results are written to `TLDR/_debug/` and a summary email is sent.

### 6. Activate the daily trigger

Run `setupDailyTrigger()` once. The pipeline will start automatically
every active weekday at 00:00 in the project's configured timezone.

Verify in the **Triggers** panel (clock icon) that exactly one
`startPipeline` trigger exists.

## Configuration

All settings live in the `CONFIG` object at the top of the script.

| Parameter | Default | Description |
|---|---|---|
| `OPENROUTER_MODEL` | `openrouter/owl-alpha` | Primary LLM model |
| `OPENROUTER_MODEL_BACKUP` | `z-ai/glm-4.5-air:free` | Fallback model on final retry attempt |
| `LONG_READ_THRESHOLD_MINUTES` | `20` | Articles above this get a teaser instead of a full summary |
| `MAX_TEXT_LENGTH` | `40000` | Characters sent to the model per article |
| `MAX_TOTAL_ARTICLES` | `4` | Hard cap on articles processed per day |
| `MAX_CONSECUTIVE_ERRORS` | `5` | Consecutive failures before early termination |
| `MAX_AI_ATTEMPTS` | `3` | Retry attempts per article before giving up |
| `STEP_TRIGGER_MINUTES` | `5` | Interval between article processing steps |
| `DRIVE_ROOT_FOLDER` | `TLDR` | Root folder name in Google Drive |
| `ACTIVE_DAYS` | `[2,3,4,5,6]` | Active days (0=Sun … 6=Sat) |

## Diagnostic functions

| Function | Purpose |
|---|---|
| `setupDailyTrigger()` | Create or recreate the daily trigger at 00:00 |
| `testDriveOnly()` | Test Drive / Docs / Gmail without AI (~30 s) |
| `testSingleArticle()` | Full end-to-end test on one article per model (~2 min) |
| `showArticles()` | List all articles found in yesterday's emails |
| `showState()` | Show current pipeline progress and pending retries |
| `emergencyReset()` | Stop a stuck pipeline and clear all state |

## Output

### Email

A styled HTML notification containing article and summary counts,
a per-source breakdown, deduplication count, and a single button
linking to the Google Doc.

### Google Doc

Saved to: `Google Drive / TLDR / YYYY / month / DD / TLDR Digest - DD.MM.YYYY`

Each article entry contains:
- Numbered title (color-coded by source)
- Metadata line: reading time, source newsletter, and summary origin when applicable
- AI-generated summary in Polish **or** a translated newsletter snippet
  (labeled *"Strona niedostępna — poniższy opis pochodzi ze skrótu newslettera TLDR"*)
  **or** an error message if neither was possible
- Link to the original article

## Notes

- Articles behind paywalls or requiring JavaScript are handled gracefully:
  the newsletter's own description is translated and used as a fallback summary
- All AI prompts instruct the model to write in Polish using plain prose
- Markdown returned by the model is stripped before writing to the Doc
- The backup model receives an increased `max_tokens` budget to account
  for chain-of-thought reasoning overhead
- Free OpenRouter models are sufficient for daily use

## License

MIT