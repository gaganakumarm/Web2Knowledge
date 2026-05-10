const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const { scrapeUrl, searchWeb } = require("./utils/anakin");

const app = express();
const PORT = process.env.PORT || 3000;

let knowledgeBase = [];

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    project: "Web2Knowledge",
  });
});

app.post("/api/build", async (req, res) => {
  try {
    const { input, mode } = req.body;

    if (!input) {
      return res.status(400).json({ error: "Input URL or topic is required" });
    }

    let urls = [];

    if (mode === "topic") {
      const searchResult = await searchWeb(input);

      const possibleResults =
        searchResult.results ||
        searchResult.data ||
        searchResult.items ||
        [];

      urls = possibleResults
        .map((item) => item.url || item.link)
        .filter(Boolean)
        .slice(0, 3);
    } else {
      urls = [input];
    }

    if (urls.length === 0) {
      return res.status(400).json({ error: "No URLs found to scrape" });
    }

    knowledgeBase = [];

    for (const url of urls) {
      const scrapeResult = await scrapeUrl(url);

      const markdown = extractMarkdown(scrapeResult);
      const title = extractTitle(scrapeResult, url);
      const chunks = chunkText(markdown);

      chunks.forEach((chunk, index) => {
        knowledgeBase.push({
          id: `${Date.now()}-${index}`,
          title,
          source: url,
          content: chunk,
          chunkIndex: index,
        });
      });
    }

    res.json({
      success: true,
      urls,
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
  res.json({
    project: "Web2Knowledge",
    totalChunks: knowledgeBase.length,
    data: knowledgeBase,
  });
});

app.listen(PORT, () => {
  console.log(`Web2Knowledge running on http://localhost:${PORT}`);
});
