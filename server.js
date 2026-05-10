const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const { agenticSearch, crawlSite, scrapeUrl, searchWeb } = require("./utils/anakin");

const app = express();
const PORT = process.env.PORT || 3000;

let knowledgeBase = [];
const TOPIC_SCRAPE_LIMIT = 1;
const TOPIC_SCRAPE_TIMEOUT_MS = 12000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function extractMarkdown(scrapeResult) {
  if (!scrapeResult) return "";

  return (
    scrapeResult.markdown ||
    scrapeResult.data?.markdown ||
    scrapeResult.result?.markdown ||
    scrapeResult.content ||
    ""
  );
}

function extractTitle(scrapeResult, fallbackUrl) {
  return (
    scrapeResult.title ||
    scrapeResult.data?.title ||
    scrapeResult.result?.title ||
    fallbackUrl
  );
}

function chunkText(text, chunkSize = 900) {
  if (!text) return [];

  const cleaned = text.replace(/\n{3,}/g, "\n\n").trim();
  const chunks = [];

  for (let i = 0; i < cleaned.length; i += chunkSize) {
    chunks.push(cleaned.slice(i, i + chunkSize));
  }

  return chunks;
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

function isValidHttpUrl(value) {
  if (!value || typeof value !== "string") return false;

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeUrl(value) {
  if (!value || typeof value !== "string") return "";
  return value.trim();
}

function collectSearchItems(value, items = []) {
  if (!value) return items;

  if (typeof value === "string") {
    items.push({
      title: value,
      url: value,
      snippet: "",
    });
    return items;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectSearchItems(item, items));
    return items;
  }

  if (typeof value === "object") {
    const candidateUrl = normalizeUrl(value.url || value.link || value.href);

    if (candidateUrl) {
      items.push({
        title: value.title || value.name || candidateUrl,
        url: candidateUrl,
        snippet:
          value.snippet ||
          value.description ||
          value.summary ||
          value.content ||
          "",
        citation: value.citation || value.citationId || value.index || "",
      });
    }

    Object.values(value).forEach((child) => {
      if (child && typeof child === "object") {
        collectSearchItems(child, items);
      }
    });
  }

  return items;
}

function extractSearchResults(searchResult) {
  const seenUrls = new Set();

  return collectSearchItems(searchResult)
    .map((item) => ({
      ...item,
      url: normalizeUrl(item.url),
      citation: item.citation,
    }))
    .filter((item) => isValidHttpUrl(item.url))
    .filter((item) => {
      if (seenUrls.has(item.url)) return false;
      seenUrls.add(item.url);
      return true;
    })
    .slice(0, 3);
}

function extractResearchSummary(researchResult) {
  return (
    researchResult.summary ||
    researchResult.answer ||
    researchResult.report ||
    researchResult.data?.summary ||
    researchResult.data?.answer ||
    researchResult.result?.summary ||
    researchResult.result?.answer ||
    researchResult.output?.summary ||
    researchResult.output?.answer ||
    ""
  );
}

function clearKnowledgeBase() {
  knowledgeBase = [];
}

function setKnowledgeBaseForTest(data) {
  knowledgeBase = Array.isArray(data) ? data : [];
}

function extractGeneratedJson(scrapeResult) {
  return (
    scrapeResult.raw?.generatedJson ||
    scrapeResult.generatedJson ||
    scrapeResult.data?.generatedJson ||
    scrapeResult.result?.generatedJson ||
    null
  );
}

async function buildKnowledgeBaseFromUrls(
  urls,
  invalidMessage = "No valid sources discovered for topic.",
  options = {}
) {
  const validUrls = urls.map(normalizeUrl).filter(isValidHttpUrl);

  if (validUrls.length === 0) {
    const error = new Error(invalidMessage);
    error.statusCode = 400;
    throw error;
  }

  if (!options.preserveExisting) {
    knowledgeBase = [];
  }

  const startingChunkCount = knowledgeBase.length;
  const failedSources = [];

  for (const [urlIndex, url] of validUrls.entries()) {
    if (options.useCrawl) {
      try {
        const crawlResult = await crawlSite(url, {
          maxPages: options.maxPages || 3,
        });

        if (crawlResult.pages.length === 0) {
          throw new Error("Anakin crawl returned no pages.");
        }

        crawlResult.pages.forEach((page, pageIndex) => {
          addChunksFromScrapeResult(page, page.url || url, `${urlIndex}-${pageIndex}`);
        });

        continue;
      } catch (error) {
        if (options.fallbackToScrape) {
          const fallbackScrape = await scrapeUrl(url);
          addChunksFromScrapeResult(fallbackScrape, url, urlIndex);
          failedSources.push({
            url,
            error: `Crawl fallback used: ${error.message}`,
          });
          continue;
        }

        if (!options.continueOnError) {
          throw error;
        }

        failedSources.push({
          url,
          error: error.message,
        });
        continue;
      }
    }

    let scrapeResult;

    try {
      const scrapePromise = scrapeUrl(url);
      scrapeResult = options.timeoutMs
        ? await withTimeout(
            scrapePromise,
            options.timeoutMs,
            `Scrape timed out after ${Math.round(options.timeoutMs / 1000)} seconds.`
          )
        : await scrapePromise;
    } catch (error) {
      if (!options.continueOnError) {
        throw error;
      }

      failedSources.push({
        url,
        error: error.message,
      });
      continue;
    }

    addChunksFromScrapeResult(scrapeResult, url, urlIndex);
  }

  if (
    knowledgeBase.length === startingChunkCount &&
    startingChunkCount === 0 &&
    options.continueOnError
  ) {
    const error = new Error(
      "Discovered sources did not finish scraping. Try a more specific topic or use a direct URL."
    );
    error.statusCode = 502;
    error.failedSources = failedSources;
    throw error;
  }

  return {
    chunks: knowledgeBase,
    failedSources,
  };
}

function addChunksFromScrapeResult(scrapeResult, url, sourceIndex) {
  const markdown = extractMarkdown(scrapeResult);
  const title = extractTitle(scrapeResult, url);
  const generatedJson = extractGeneratedJson(scrapeResult);
  const chunks = chunkText(markdown);

  chunks.forEach((chunk, chunkIndex) => {
    knowledgeBase.push({
      id: `${Date.now()}-${sourceIndex}-${chunkIndex}`,
      title,
      source: url,
      content: chunk,
      chunkIndex,
      generatedJson,
    });
  });
}

function seedKnowledgeBaseFromSources(sources, topic, researchSummary = "") {
  knowledgeBase = [];

  if (researchSummary) {
    chunkText(researchSummary, 900).forEach((chunk, chunkIndex) => {
      knowledgeBase.push({
        id: `summary-${Date.now()}-${chunkIndex}`,
        title: `Research summary: ${topic}`,
        source: "Anakin Agentic Search",
        content: chunk,
        chunkIndex,
      });
    });
  }

  sources.forEach((source, sourceIndex) => {
    const content = [
      source.title,
      source.snippet,
      source.citation ? `Citation: ${source.citation}` : "",
      `Source: ${source.url}`,
      `Research topic: ${topic}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    chunkText(content, 700).forEach((chunk, chunkIndex) => {
      knowledgeBase.push({
        id: `search-${Date.now()}-${sourceIndex}-${chunkIndex}`,
        title: source.title || source.url,
        source: source.url,
        content: chunk,
        chunkIndex,
      });
    });
  });
}

async function buildStandardTopicKnowledgeBase(query) {
  let searchResult;

  try {
    searchResult = await searchWeb(query);
  } catch (error) {
    return runAgenticTopicKnowledgeBase(query, {
      fallbackReason: `Standard Search failed: ${error.message}`,
      fromFallback: true,
    });
  }

  const discoveredSources = extractSearchResults(searchResult);
  const urls = discoveredSources.map((item) => item.url);

  if (urls.length === 0) {
    const error = new Error("No valid sources discovered for topic.");
    error.statusCode = 400;
    throw error;
  }

  seedKnowledgeBaseFromSources(discoveredSources, query);

  const buildResult = await buildKnowledgeBaseFromUrls(
    urls.slice(0, TOPIC_SCRAPE_LIMIT),
    "No valid sources discovered for topic.",
    {
      continueOnError: true,
      preserveExisting: true,
      timeoutMs: TOPIC_SCRAPE_TIMEOUT_MS,
    }
  );

  return {
    researchMode: "standard",
    urls,
    discoveredSources,
    totalSourcesDiscovered: discoveredSources.length,
    failedSources: buildResult.failedSources,
    researchSummary: extractResearchSummary(searchResult),
    agenticFallback: false,
  };
}

async function buildAgenticTopicKnowledgeBase(query) {
  return runAgenticTopicKnowledgeBase(query, {});
}

async function runAgenticTopicKnowledgeBase(query, options) {
  let researchResult;

  try {
    researchResult = await agenticSearch(query);
  } catch (error) {
    if (options.fromFallback) {
      throw error;
    }

    const fallback = await buildStandardTopicKnowledgeBase(query);
    return {
      ...fallback,
      agenticFallback: true,
      fallbackReason: error.message,
    };
  }

  const discoveredSources = extractSearchResults(researchResult);
  const urls = discoveredSources.map((item) => item.url);
  const researchSummary = extractResearchSummary(researchResult);

  if (urls.length === 0) {
    if (options.fromFallback) {
      const error = new Error("Agentic Search returned no valid source URLs.");
      error.statusCode = 400;
      throw error;
    }

    const fallback = await buildStandardTopicKnowledgeBase(query);
    return {
      ...fallback,
      agenticFallback: true,
      fallbackReason: "Agentic Search returned no valid source URLs.",
    };
  }

  seedKnowledgeBaseFromSources(discoveredSources, query, researchSummary);

  const buildResult = await buildKnowledgeBaseFromUrls(
    urls.slice(0, TOPIC_SCRAPE_LIMIT),
    "No valid sources discovered for topic.",
    {
      continueOnError: true,
      preserveExisting: true,
      timeoutMs: TOPIC_SCRAPE_TIMEOUT_MS,
    }
  );

  return {
    researchMode: "agentic",
    urls,
    discoveredSources,
    totalSourcesDiscovered: discoveredSources.length,
    failedSources: buildResult.failedSources,
    researchSummary,
    agenticFallback: Boolean(options.fromFallback),
    fallbackReason: options.fallbackReason,
  };
}

async function buildTopicKnowledgeBase(query, researchMode = "standard") {
  if (researchMode === "agentic") {
    return buildAgenticTopicKnowledgeBase(query);
  }

  return buildStandardTopicKnowledgeBase(query);
}

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    project: "Web2Knowledge",
  });
});

app.post("/api/build", async (req, res) => {
  try {
    const { input, mode, researchMode, extractionMode } = req.body;
    clearKnowledgeBase();

    if (!input) {
      return res.status(400).json({ error: "Input URL is required" });
    }

    if (mode === "topic" || !isValidHttpUrl(input)) {
      const topicResult = await buildTopicKnowledgeBase(input, researchMode);

      return res.json({
        success: true,
        mode: "topic",
        researchMode: topicResult.researchMode,
        topic: input,
        urls: topicResult.urls,
        discoveredSources: topicResult.discoveredSources,
        totalSourcesDiscovered: topicResult.totalSourcesDiscovered,
        failedSources: topicResult.failedSources,
        researchSummary: topicResult.researchSummary,
        agenticFallback: topicResult.agenticFallback,
        fallbackReason: topicResult.fallbackReason,
        totalChunks: knowledgeBase.length,
        sample: knowledgeBase.slice(0, 3),
      });
    }

    const urls = [input];
    const buildResult = await buildKnowledgeBaseFromUrls(
      urls,
      "Please enter a valid http/https URL.",
      {
        useCrawl: extractionMode === "crawl",
        maxPages: 3,
        fallbackToScrape: true,
      }
    );

    res.json({
      success: true,
      extractionMode: extractionMode === "crawl" ? "crawl" : "scrape",
      urls,
      discoveredSources: urls.map((url) => ({ title: url, url, snippet: "" })),
      totalSourcesDiscovered: urls.length,
      failedSources: buildResult.failedSources,
      totalChunks: knowledgeBase.length,
      sample: knowledgeBase.slice(0, 3),
    });
  } catch (error) {
    console.error("Build error:", error.response?.data || error.message);

    res.status(error.statusCode || error.response?.status || 500).json({
      error: "Failed to build knowledge base",
      details: error.response?.data || error.message,
    });
  }
});

app.post("/api/topic-build", async (req, res) => {
  try {
    const { input, topic, researchMode } = req.body;
    const query = input || topic;
    clearKnowledgeBase();

    if (!query) {
      return res.status(400).json({ error: "Topic is required" });
    }

    const topicResult = await buildTopicKnowledgeBase(query, researchMode);

    res.json({
      success: true,
      mode: "topic",
      researchMode: topicResult.researchMode,
      topic: query,
      urls: topicResult.urls,
      discoveredSources: topicResult.discoveredSources,
      totalSourcesDiscovered: topicResult.totalSourcesDiscovered,
      failedSources: topicResult.failedSources,
      researchSummary: topicResult.researchSummary,
      agenticFallback: topicResult.agenticFallback,
      fallbackReason: topicResult.fallbackReason,
      totalChunks: knowledgeBase.length,
      sample: knowledgeBase.slice(0, 3),
    });
  } catch (error) {
    console.error("Topic build error:", error.response?.data || error.message);

    res.status(error.statusCode || error.response?.status || 500).json({
      error: "Failed to build topic knowledge base",
      details: error.response?.data || error.message,
    });
  }
});

app.get("/api/search", (req, res) => {
  const q = (req.query.q || "").toLowerCase();

  if (!q) {
    return res.json({
      results: knowledgeBase.slice(0, 20),
      total: knowledgeBase.length,
    });
  }

  const results = knowledgeBase
    .filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.content.toLowerCase().includes(q) ||
        item.source.toLowerCase().includes(q)
    )
    .slice(0, 20);

  res.json({
    query: q,
    total: results.length,
    results,
  });
});

app.get("/api/export", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="web2knowledge-dataset.json"'
  );

  res.send(JSON.stringify({
    project: "Web2Knowledge",
    generatedAt: new Date().toISOString(),
    totalChunks: knowledgeBase.length,
    data: knowledgeBase,
  }, null, 2));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Web2Knowledge running on http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  chunkText,
  clearKnowledgeBase,
  extractResearchSummary,
  extractSearchResults,
  isValidHttpUrl,
  setKnowledgeBaseForTest,
};
