const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const { agenticSearch, crawlSite, scrapeUrl, searchWeb } = require("./utils/anakin");
const {
  activateProject,
  clearChunks,
  closeDatabaseForTest,
  createProject,
  getActiveProject,
  listProjects,
  loadChunks,
  saveChunks,
  updateProjectMetadata,
} = require("./utils/storage");

const app = express();
const PORT = process.env.PORT || 3000;

let knowledgeBase = loadChunks();
let activeProject = getActiveProject();
const TOPIC_SCRAPE_LIMIT = 1;
const TOPIC_SCRAPE_TIMEOUT_MS = 12000;
const SEARCH_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

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
  const blocks = splitMarkdownBlocks(cleaned);
  const chunks = [];
  let currentChunk = "";

  blocks.forEach((block) => {
    const startsNewSection = /^#{1,6}\s+\S/.test(block);

    if (startsNewSection && currentChunk) {
      chunks.push(currentChunk);
      currentChunk = "";
    }

    if (block.length > chunkSize) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = "";
      }

      chunks.push(...splitLargeBlock(block, chunkSize));
      return;
    }

    const nextChunk = currentChunk ? `${currentChunk}\n\n${block}` : block;

    if (nextChunk.length <= chunkSize) {
      currentChunk = nextChunk;
      return;
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    currentChunk = block;
  });

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function splitMarkdownBlocks(text) {
  const blocks = [];
  let currentBlock = [];

  text.split("\n").forEach((line) => {
    const isHeading = /^#{1,6}\s+\S/.test(line);
    const isBlank = line.trim() === "";

    if (isHeading && currentBlock.length > 0) {
      blocks.push(currentBlock.join("\n").trim());
      currentBlock = [];
    }

    if (isBlank) {
      if (currentBlock.length > 0) {
        blocks.push(currentBlock.join("\n").trim());
        currentBlock = [];
      }
      return;
    }

    currentBlock.push(line);
  });

  if (currentBlock.length > 0) {
    blocks.push(currentBlock.join("\n").trim());
  }

  return blocks.filter(Boolean);
}

function splitLargeBlock(block, chunkSize) {
  const chunks = [];
  let remaining = block.trim();

  while (remaining.length > chunkSize) {
    const splitAt = findSplitPoint(remaining, chunkSize);
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function findSplitPoint(text, chunkSize) {
  const window = text.slice(0, chunkSize + 1);
  const sentenceBreak = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("? "),
    window.lastIndexOf("! ")
  );

  if (sentenceBreak > chunkSize * 0.5) {
    return sentenceBreak + 1;
  }

  const wordBreak = window.lastIndexOf(" ");
  return wordBreak > chunkSize * 0.5 ? wordBreak : chunkSize;
}

function normalizeSearchToken(token) {
  const value = token.toLowerCase();

  if (value.startsWith("rout")) return "route";
  if (value === "docs" || value === "documentation") return "doc";
  if (value === "datasets") return "dataset";
  if (value === "classes") return "class";

  return value
    .replace(/(?:ing|ed|es|s)$/u, "")
    .replace(/[^a-z0-9]/gu, "");
}

function tokenizeSearchText(text) {
  return String(text || "")
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.map(normalizeSearchToken)
    .filter((token) => token.length > 1 && !SEARCH_STOPWORDS.has(token)) || [];
}

function countTokens(tokens) {
  return tokens.reduce((counts, token) => {
    counts.set(token, (counts.get(token) || 0) + 1);
    return counts;
  }, new Map());
}

function cosineSimilarity(queryTokens, documentTokens) {
  if (queryTokens.length === 0 || documentTokens.length === 0) return 0;

  const queryCounts = countTokens(queryTokens);
  const documentCounts = countTokens(documentTokens);
  let dotProduct = 0;
  let queryMagnitude = 0;
  let documentMagnitude = 0;

  queryCounts.forEach((count, token) => {
    dotProduct += count * (documentCounts.get(token) || 0);
    queryMagnitude += count ** 2;
  });

  documentCounts.forEach((count) => {
    documentMagnitude += count ** 2;
  });

  if (dotProduct === 0) return 0;

  return dotProduct / (Math.sqrt(queryMagnitude) * Math.sqrt(documentMagnitude));
}

function scoreSearchResult(item, query) {
  const normalizedQuery = query.toLowerCase();
  const title = item.title.toLowerCase();
  const content = item.content.toLowerCase();
  const source = item.source.toLowerCase();
  const queryTokens = tokenizeSearchText(query);
  const documentTokens = tokenizeSearchText(`${item.title} ${item.content} ${item.source}`);
  let score = cosineSimilarity(queryTokens, documentTokens);

  if (title.includes(normalizedQuery)) score += 2;
  if (content.includes(normalizedQuery)) score += 1;
  if (source.includes(normalizedQuery)) score += 0.5;

  return score;
}

function rankKnowledgeBase(query, limit = 20) {
  return knowledgeBase
    .map((item) => ({
      ...item,
      score: scoreSearchResult(item, query),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function splitSentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function buildExtractiveAnswer(question) {
  const context = rankKnowledgeBase(question, 5);

  if (context.length === 0 || context[0].score < 0.05) {
    return {
      answer: "I could not find matching context in the current knowledge base.",
      citations: [],
      totalContextChunks: 0,
    };
  }

  const candidateSentences = context.flatMap((chunk) =>
    splitSentences(chunk.content).map((sentence) => ({
      sentence,
      chunk,
      score: scoreSearchResult(
        {
          title: chunk.title,
          source: chunk.source,
          content: sentence,
        },
        question
      ),
    }))
  );

  const selectedSentences = candidateSentences
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const answer = selectedSentences.length
    ? selectedSentences.map((item) => item.sentence).join(" ")
    : context
        .slice(0, 2)
        .map((chunk) => chunk.content.slice(0, 260))
        .join(" ");

  const citations = context.slice(0, 3).map((chunk) => ({
    title: chunk.title,
    source: chunk.source,
    chunkIndex: chunk.chunkIndex,
    score: chunk.score,
  }));

  return {
    answer,
    citations,
    totalContextChunks: context.length,
  };
}

function getExportPayload(format = "web2knowledge") {
  const project = getActiveProject();
  const generatedAt = new Date().toISOString();
  const safeFormat = String(format || "web2knowledge").toLowerCase();

  if (safeFormat === "langchain") {
    return {
      filename: "web2knowledge-langchain.json",
      body: knowledgeBase.map((chunk) => ({
        pageContent: chunk.content,
        metadata: {
          id: chunk.id,
          title: chunk.title,
          source: chunk.source,
          chunkIndex: chunk.chunkIndex,
          projectId: chunk.projectId || project?.id || "",
          generatedJson: chunk.generatedJson || null,
        },
      })),
    };
  }

  if (safeFormat === "llamaindex") {
    return {
      filename: "web2knowledge-llamaindex.json",
      body: knowledgeBase.map((chunk) => ({
        id_: chunk.id,
        text: chunk.content,
        metadata: {
          title: chunk.title,
          source: chunk.source,
          chunkIndex: chunk.chunkIndex,
          projectId: chunk.projectId || project?.id || "",
        },
      })),
    };
  }

  if (safeFormat === "pinecone") {
    return {
      filename: "web2knowledge-pinecone.json",
      body: knowledgeBase.map((chunk) => ({
        id: chunk.id,
        metadata: {
          text: chunk.content,
          title: chunk.title,
          source: chunk.source,
          chunkIndex: chunk.chunkIndex,
          projectId: chunk.projectId || project?.id || "",
        },
      })),
    };
  }

  if (safeFormat === "supabase") {
    return {
      filename: "web2knowledge-supabase.json",
      body: knowledgeBase.map((chunk) => ({
        id: chunk.id,
        project_id: chunk.projectId || project?.id || "",
        title: chunk.title,
        source: chunk.source,
        content: chunk.content,
        chunk_index: chunk.chunkIndex,
        metadata: {
          generatedJson: chunk.generatedJson || null,
        },
      })),
    };
  }

  if (safeFormat === "lancedb" || safeFormat === "lance") {
    return {
      filename: "web2knowledge-lancedb.json",
      body: knowledgeBase.map((chunk) => ({
        id: chunk.id,
        text: chunk.content,
        title: chunk.title,
        source: chunk.source,
        chunk_index: chunk.chunkIndex,
        project_id: chunk.projectId || project?.id || "",
      })),
    };
  }

  return {
    filename: "web2knowledge-dataset.json",
    body: {
      project: "Web2Knowledge",
      projectId: project?.id || "",
      projectName: project?.name || "",
      generatedAt,
      totalChunks: knowledgeBase.length,
      data: knowledgeBase,
    },
  };
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
      const key = canonicalSourceUrl(item.url);
      if (seenUrls.has(key)) return false;
      seenUrls.add(key);
      return true;
    })
    .slice(0, 3);
}

function canonicalSourceUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.searchParams.sort();
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return String(url || "").trim().toLowerCase();
  }
}

function normalizeDedupText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

function chunkExists(source, content) {
  const sourceKey = canonicalSourceUrl(source);
  const contentKey = normalizeDedupText(content);

  return knowledgeBase.some(
    (chunk) =>
      canonicalSourceUrl(chunk.source) === sourceKey &&
      normalizeDedupText(chunk.content) === contentKey
  );
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
  clearChunks();
  activeProject = getActiveProject();
}

function setKnowledgeBaseForTest(data) {
  knowledgeBase = Array.isArray(data) ? data : [];
  saveChunks(knowledgeBase);
  activeProject = getActiveProject();
}

function buildProjectName(input, mode) {
  const label = mode === "topic" ? "Topic" : "URL";
  const value = String(input || "Untitled").trim();
  return `${label}: ${value.length > 60 ? `${value.slice(0, 57)}...` : value}`;
}

function startProject(metadata) {
  knowledgeBase = [];
  activeProject = createProject({
    ...metadata,
    name: metadata.name || buildProjectName(metadata.input, metadata.mode),
  });
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

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function htmlToReadableText(html) {
  return decodeHtmlEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<\/(h[1-6]|p|li|div|section|article|main|header|footer)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function extractHtmlTitle(html, fallbackUrl) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtmlEntities(match[1]).trim() : fallbackUrl;
}

async function fetchUrlFallback(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Web2Knowledge/1.0",
      Accept: "text/html,text/plain,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new Error(`Fallback fetch failed with HTTP ${response.status}.`);
  }

  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  const markdown = contentType.includes("text/plain")
    ? text.trim()
    : htmlToReadableText(text);

  if (!markdown) {
    throw new Error("Fallback fetch returned no readable text.");
  }

  return {
    url,
    title: contentType.includes("text/plain") ? url : extractHtmlTitle(text, url),
    markdown,
    generatedJson: {
      extractionProvider: "local-fetch-fallback",
    },
  };
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
    saveChunks(knowledgeBase);
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
      if (error.statusCode !== 401 && !options.disableLocalFallback) {
        try {
          scrapeResult = await fetchUrlFallback(url);
        } catch (fallbackError) {
          if (!options.continueOnError) {
            const combinedError = new Error(
              `${error.message}; local fallback failed: ${fallbackError.message}`
            );
            combinedError.statusCode = error.statusCode || 502;
            throw combinedError;
          }

          failedSources.push({
            url,
            error: `${error.message}; fallback failed: ${fallbackError.message}`,
          });
          continue;
        }
      } else if (!options.continueOnError) {
        throw error;
      }

      if (scrapeResult) {
        addChunksFromScrapeResult(scrapeResult, url, urlIndex);
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
    if (chunkExists(url, chunk)) return;

    knowledgeBase.push({
      id: `${Date.now()}-${sourceIndex}-${chunkIndex}`,
      title,
      source: url,
      content: chunk,
      chunkIndex,
      generatedJson,
    });
  });

  saveChunks(knowledgeBase);
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
      if (chunkExists(source.url, chunk)) return;

      knowledgeBase.push({
        id: `search-${Date.now()}-${sourceIndex}-${chunkIndex}`,
        title: source.title || source.url,
        source: source.url,
        content: chunk,
        chunkIndex,
      });
    });
  });

  saveChunks(knowledgeBase);
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

    if (!input) {
      return res.status(400).json({ error: "Input URL is required" });
    }

    if (mode === "topic" || !isValidHttpUrl(input)) {
      startProject({
        input,
        mode: "topic",
        researchMode: researchMode || "standard",
        extractionMode: "",
      });
      const topicResult = await buildTopicKnowledgeBase(input, researchMode);
      updateProjectMetadata(activeProject.id, {
        totalSources: topicResult.totalSourcesDiscovered,
        totalChunks: knowledgeBase.length,
        sources: topicResult.discoveredSources,
        summary: topicResult.researchSummary,
        researchMode: topicResult.researchMode,
      });

      return res.json({
        success: true,
        project: getActiveProject(),
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

    startProject({
      input,
      mode: "url",
      researchMode: researchMode || "standard",
      extractionMode: extractionMode === "crawl" ? "crawl" : "scrape",
    });
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
    updateProjectMetadata(activeProject.id, {
      totalSources: urls.length,
      totalChunks: knowledgeBase.length,
      sources: urls.map((url) => ({ title: url, url, snippet: "" })),
    });

    res.json({
      success: true,
      project: getActiveProject(),
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

    if (!query) {
      return res.status(400).json({ error: "Topic is required" });
    }

    startProject({
      input: query,
      mode: "topic",
      researchMode: researchMode || "standard",
      extractionMode: "",
    });
    const topicResult = await buildTopicKnowledgeBase(query, researchMode);
    updateProjectMetadata(activeProject.id, {
      totalSources: topicResult.totalSourcesDiscovered,
      totalChunks: knowledgeBase.length,
      sources: topicResult.discoveredSources,
      summary: topicResult.researchSummary,
      researchMode: topicResult.researchMode,
    });

    res.json({
      success: true,
      project: getActiveProject(),
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

  const results = rankKnowledgeBase(q, 20);

  res.json({
    query: q,
    total: results.length,
    results,
  });
});

app.get("/api/projects", (req, res) => {
  res.json({
    activeProject: getActiveProject(),
    projects: listProjects(),
  });
});

app.post("/api/projects/:id/activate", (req, res) => {
  try {
    const project = activateProject(req.params.id);
    activeProject = project;
    knowledgeBase = loadChunks(project.id);

    res.json({
      success: true,
      project,
      totalChunks: knowledgeBase.length,
      sample: knowledgeBase.slice(0, 3),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: "Failed to activate project",
      details: error.message,
    });
  }
});

app.post("/api/ask", (req, res) => {
  const { question } = req.body;

  if (!question || !String(question).trim()) {
    return res.status(400).json({ error: "Question is required" });
  }

  res.json({
    question,
    ...buildExtractiveAnswer(question),
  });
});

app.get("/api/export", (req, res) => {
  const { format } = req.query;
  const exportPayload = getExportPayload(format);

  res.setHeader("Content-Type", "application/json");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${exportPayload.filename}"`
  );

  res.send(JSON.stringify(exportPayload.body, null, 2));
});

app.delete("/api/dataset", (req, res) => {
  clearKnowledgeBase();

  res.json({
    success: true,
    totalChunks: knowledgeBase.length,
    activeProject: getActiveProject(),
  });
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
  closeDatabaseForTest,
  extractResearchSummary,
  extractSearchResults,
  getExportPayload,
  isValidHttpUrl,
  setKnowledgeBaseForTest,
};
