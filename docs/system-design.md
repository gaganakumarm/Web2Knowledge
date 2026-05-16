# Web2Knowledge - System Design

## System Overview

Web2Knowledge is an Express application that converts public URLs and research topics into a persistent, searchable, exportable knowledge base.

The current architecture is intentionally lightweight but product-ready:

- Express backend.
- Static frontend served from `public/`.
- Local CSS and vanilla JavaScript.
- In-memory active dataset backed by SQLite persistence.
- Anakin APIs for search, agentic research, scraping, and crawling.
- Local URL fetch fallback for direct URL extraction.
- Ranked local search and extractive ask flow.

---

## High-Level Architecture

```mermaid
flowchart TD
  UI[Browser UI] --> Static[Static files: index.html, styles.css, app.js]
  UI --> API[Express API]
  API --> Build[POST /api/build]
  API --> Topic[POST /api/topic-build]
  API --> Search[GET /api/search]
  API --> Ask[POST /api/ask]
  API --> Export[GET /api/export]
  API --> Clear[DELETE /api/dataset]

  Build --> UrlCheck{Valid http/https URL?}
  UrlCheck -->|Yes + scrape| Scraper[Anakin URL Scraper]
  UrlCheck -->|Yes + crawl| Crawl[Anakin Crawl]
  UrlCheck -->|No| Topic

  Scraper -->|Non-auth failure| LocalFetch[Local fetch fallback]
  Scraper --> Poll[Poll scrape job]
  Crawl --> CrawlPoll[Poll crawl job]

  Topic --> Mode{Research mode}
  Mode -->|Standard| SearchAPI[Anakin Search API]
  Mode -->|Agentic| AgenticAPI[Anakin Agentic Search API]
  AgenticAPI --> AgentPoll[Poll agentic job]
  AgentPoll -->|Timeout/failure/no URLs| SearchAPI

  SearchAPI --> Sources[Normalize valid URLs]
  AgentPoll --> Sources
  Sources --> Seed[Seed chunks from source metadata]
  Sources --> OptionalScrape[Optional top-source scrape]
  OptionalScrape --> Poll

  Poll --> Normalize[Normalize extracted content]
  CrawlPoll --> Normalize
  LocalFetch --> Normalize
  Normalize --> Chunk[Markdown-aware chunking]
  Seed --> Store[(Active dataset)]
  Chunk --> Store
  Store --> SQLite[(SQLite data/web2knowledge.sqlite)]
  SQLite --> Hydrate[Hydrate saved dataset on startup]
  Hydrate --> Store
  Search --> Store
  Ask --> Store
  Export --> Store
  Clear --> Store
```

---

## Runtime Components

## 1. Frontend

Files:

```text
public/index.html
public/styles.css
public/app.js
```

Responsibilities:

- Render the product app shell.
- Let users build from URL or topic.
- Let users choose URL extraction, crawl, standard research, or deep research.
- Show saved dataset stats.
- Load saved chunks on page load.
- Provide top-level tabs for Build, Workspace, Ask, and Guide.
- Search chunks.
- Ask questions over the active dataset.
- Show Results, Sources, and Summary workspace tabs.
- Clear and export the dataset.
- Render the built-in user guide.

The frontend uses local CSS and does not depend on Tailwind CDN or a frontend build process.

---

## 2. Backend

File:

```text
server.js
```

Responsibilities:

- Serve static frontend assets.
- Validate inputs.
- Route URL builds and topic builds.
- Call the Anakin utility layer.
- Use local fallback extraction when direct URL scraping fails with a non-auth error.
- Chunk content by markdown-like structure.
- Maintain the active in-memory dataset.
- Persist chunks through the storage layer.
- Rank search results.
- Build extractive answers with citations.
- Guard against unrelated low-confidence ask responses.
- Export and clear datasets.

---

## 3. Anakin Utility Layer

File:

```text
utils/anakin.js
```

Responsibilities:

- Read Anakin API key from environment.
- Build Anakin request headers.
- Validate API key presence.
- Validate direct scrape URLs.
- Call URL Scraper.
- Call Crawl.
- Call Standard Search.
- Call Agentic Search.
- Poll async URL Scraper jobs.
- Poll async Crawl jobs.
- Poll async Agentic Search jobs.
- Normalize scraper/crawl responses.
- Return actionable errors for auth, endpoint, timeout, and API failures.

---

## 4. Storage Layer

File:

```text
utils/storage.js
```

Responsibilities:

- Create/open SQLite database.
- Create the `chunks` table.
- Load saved chunks at server startup.
- Save the active dataset after mutations.
- Clear chunks.
- Close the database during tests.

Default database path:

```text
data/web2knowledge.sqlite
```

Tests can override this with:

```text
KB_DB_PATH
```

---

## API Endpoints

## `GET /health`

Returns:

```json
{
  "status": "ok",
  "project": "Web2Knowledge"
}
```

## `POST /api/build`

Builds from URL input. Plain text input is routed to topic mode.

Payload:

```json
{
  "input": "https://tailwindcss.com/docs",
  "mode": "url",
  "researchMode": "standard",
  "extractionMode": "scrape"
}
```

URL behavior:

- `extractionMode: "scrape"` uses Anakin URL Scraper.
- `extractionMode: "crawl"` uses Anakin Crawl.
- Non-auth URL scrape failures attempt local fetch fallback.
- Successful builds replace the active dataset.

## `POST /api/topic-build`

Builds from topic input.

Payload:

```json
{
  "input": "AI agents for software development",
  "mode": "topic",
  "researchMode": "agentic"
}
```

Topic behavior:

- Standard mode uses Anakin Search.
- Agentic mode uses Anakin Agentic Search first.
- Agentic timeout/failure/no URLs falls back to Standard Search.
- Sources are normalized, filtered to HTTP/HTTPS, deduped, and limited.
- Source metadata seeds initial chunks.
- The top discovered source is scraped with a short timeout.

## `GET /api/search`

Returns saved chunks when no query is provided:

```text
/api/search
```

Searches ranked chunks when a query is provided:

```text
/api/search?q=javascript
```

Search behavior:

- Tokenizes query and document text.
- Removes common stopwords.
- Applies light token normalization.
- Uses cosine-style token similarity.
- Adds boosts for exact query matches in title/content/source.
- Returns up to 20 results.

## `POST /api/ask`

Answers from the active dataset.

Payload:

```json
{
  "question": "What is JavaScript?"
}
```

Ask behavior:

- Retrieves top-ranked chunks.
- Extracts and ranks candidate sentences.
- Returns up to three citations.
- Returns a safe no-context answer when confidence is too low.

## `GET /api/export`

Downloads:

```text
web2knowledge-dataset.json
```

## `DELETE /api/dataset`

Clears the active dataset from memory and SQLite.

---

## Data Flow

## URL Mode

```mermaid
sequenceDiagram
  participant U as User
  participant UI as Browser UI
  participant API as Express API
  participant A as Anakin URL Scraper/Crawl
  participant F as Local Fetch Fallback
  participant S as SQLite Storage

  U->>UI: Enter public URL
  UI->>API: POST /api/build
  API->>API: Validate http/https URL
  API->>A: Submit scrape/crawl request
  alt Async job
    loop Until completed or timeout
      API->>A: Poll job endpoint
      A-->>API: Job status/result
    end
  end
  alt Non-auth scrape failure
    API->>F: Fetch URL directly
    F-->>API: HTML/text
  end
  API->>API: Normalize readable text
  API->>API: Chunk by markdown structure
  API->>S: Save chunks
  API-->>UI: Build response
```

## Topic Mode

```mermaid
flowchart TD
  A[Topic input] --> B{Research mode}
  B -->|Standard| C[Anakin Search]
  B -->|Agentic| D[Anakin Agentic Search]
  D -->|Fallback| C
  C --> E[Normalize sources]
  D --> E
  E --> F[Seed chunks from title/snippet/source]
  E --> G[Scrape top source]
  G --> H[Append extracted chunks]
  F --> I[(SQLite-backed active dataset)]
  H --> I
```

## Ask Flow

```mermaid
flowchart TD
  A[Question] --> B[Rank chunks]
  B --> C{Top score high enough?}
  C -->|No| D[No matching context answer]
  C -->|Yes| E[Split top chunks into sentences]
  E --> F[Rank candidate sentences]
  F --> G[Compose extractive answer]
  G --> H[Return citations]
```

---

## Chunk Model

```json
{
  "id": "string",
  "title": "string",
  "source": "string",
  "content": "string",
  "chunkIndex": 0,
  "generatedJson": {}
}
```

---

## Error Handling

The system handles:

- Missing Anakin API key.
- Invalid URL input.
- Topic input accidentally submitted through URL build.
- Empty source discovery results.
- Agentic Search failure or timeout.
- Slow topic source scraping.
- URL Scraper job timeout.
- Crawl job timeout.
- Direct URL scrape non-auth failures through local fallback.
- Unrelated ask questions through a low-confidence guard.

---

## Test Coverage

Run:

```powershell
npm.cmd test
```

Current automated coverage: `23` tests.

The suite verifies:

- Homepage and static assets.
- Health route.
- Export route.
- Dataset clear route.
- SQLite persistence.
- Request validation.
- Search behavior.
- Ask behavior.
- Unrelated question guard.
- URL validation.
- Markdown-aware chunking.
- Search result normalization.
- Citation and summary extraction.

---

## Security Notes

- `.env` is ignored by git.
- Anakin key is read server-side only.
- User-rendered content is escaped in the frontend.
- Only `http` and `https` URLs are accepted for scraping.
- Local fallback is skipped for auth errors so invalid API keys are not hidden.

---

## System Summary

Web2Knowledge uses Anakin as the discovery and extraction engine, then keeps the product workflow local and lightweight: Express routes, local static UI, SQLite persistence, ranked search, extractive ask, and exportable JSON. It is designed to be understandable, demo-friendly, and extensible without requiring a frontend framework or vector database in the current version.
