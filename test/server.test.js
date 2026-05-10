const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const {
  app,
  chunkText,
  clearKnowledgeBase,
  extractResearchSummary,
  extractSearchResults,
  isValidHttpUrl,
  setKnowledgeBaseForTest,
} = require("../server");

function startTestServer() {
  const server = http.createServer(app);

  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test("home route serves the browser app", async () => {
  const server = await startTestServer();

  try {
    const response = await fetch(`${server.baseUrl}/`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(html, /Web2Knowledge/);
    assert.match(html, /Build Knowledge Base/);
  } finally {
    await server.close();
  }
});

test("health route returns service status", async () => {
  const server = await startTestServer();

  try {
    const response = await fetch(`${server.baseUrl}/health`);
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.status, "ok");
    assert.equal(data.project, "Web2Knowledge");
  } finally {
    await server.close();
  }
});

test("export route downloads JSON dataset", async () => {
  const server = await startTestServer();

  try {
    clearKnowledgeBase();
    const response = await fetch(`${server.baseUrl}/api/export`);
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.equal(
      response.headers.get("content-disposition"),
      'attachment; filename="web2knowledge-dataset.json"'
    );
    assert.equal(data.project, "Web2Knowledge");
    assert.equal(typeof data.generatedAt, "string");
    assert.equal(data.totalChunks, 0);
    assert.deepEqual(data.data, []);
  } finally {
    await server.close();
  }
});

test("export route includes generated chunks and metadata", async () => {
  const server = await startTestServer();

  try {
    setKnowledgeBaseForTest([
      {
        id: "chunk-1",
        title: "Tailwind Docs",
        source: "https://tailwindcss.com/docs",
        content: "Tailwind utility classes",
        chunkIndex: 0,
        generatedJson: { category: "docs" },
      },
    ]);

    const response = await fetch(`${server.baseUrl}/api/export`);
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.totalChunks, 1);
    assert.equal(data.data[0].title, "Tailwind Docs");
    assert.deepEqual(data.data[0].generatedJson, { category: "docs" });
  } finally {
    clearKnowledgeBase();
    await server.close();
  }
});

test("build route rejects missing input before calling Anakin", async () => {
  const server = await startTestServer();

  try {
    const response = await fetch(`${server.baseUrl}/api/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await response.json();

    assert.equal(response.status, 400);
    assert.equal(data.error, "Input URL is required");
  } finally {
    await server.close();
  }
});

test("topic build route rejects missing topic before calling Anakin", async () => {
  const server = await startTestServer();

  try {
    const response = await fetch(`${server.baseUrl}/api/topic-build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await response.json();

    assert.equal(response.status, 400);
    assert.equal(data.error, "Topic is required");
  } finally {
    await server.close();
  }
});

test("search route returns all chunks when query is empty", async () => {
  const server = await startTestServer();

  try {
    setKnowledgeBaseForTest([
      {
        id: "1",
        title: "Next.js Routing",
        source: "https://nextjs.org/docs",
        content: "File-system routing and dynamic segments",
        chunkIndex: 0,
      },
      {
        id: "2",
        title: "Tailwind Docs",
        source: "https://tailwindcss.com/docs",
        content: "Utility classes",
        chunkIndex: 0,
      },
    ]);

    const response = await fetch(`${server.baseUrl}/api/search`);
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.total, 2);
    assert.equal(data.results.length, 2);
  } finally {
    clearKnowledgeBase();
    await server.close();
  }
});

test("search route matches title, source, and content", async () => {
  const server = await startTestServer();

  try {
    setKnowledgeBaseForTest([
      {
        id: "1",
        title: "Next.js Routing",
        source: "https://nextjs.org/docs",
        content: "File-system routing and dynamic segments",
        chunkIndex: 0,
      },
      {
        id: "2",
        title: "Tailwind Docs",
        source: "https://tailwindcss.com/docs",
        content: "Utility classes",
        chunkIndex: 0,
      },
    ]);

    const byTitle = await fetch(`${server.baseUrl}/api/search?q=next`);
    const bySource = await fetch(`${server.baseUrl}/api/search?q=tailwindcss`);
    const byContent = await fetch(`${server.baseUrl}/api/search?q=dynamic`);
    const noMatch = await fetch(`${server.baseUrl}/api/search?q=python`);

    assert.equal((await byTitle.json()).results.length, 1);
    assert.equal((await bySource.json()).results.length, 1);
    assert.equal((await byContent.json()).results.length, 1);
    assert.equal((await noMatch.json()).results.length, 0);
  } finally {
    clearKnowledgeBase();
    await server.close();
  }
});

test("URL validation accepts only http and https URLs", () => {
  assert.equal(isValidHttpUrl("https://tailwindcss.com/docs"), true);
  assert.equal(isValidHttpUrl("http://example.com"), true);
  assert.equal(isValidHttpUrl(" https://example.com "), true);
  assert.equal(isValidHttpUrl("Next.js routing"), false);
  assert.equal(isValidHttpUrl("ftp://example.com"), false);
  assert.equal(isValidHttpUrl(""), false);
});

test("chunkText cleans excessive blank lines and chunks content", () => {
  const chunks = chunkText("one\n\n\n\ntwo\nthree", 5);

  assert.deepEqual(chunks, ["one\n\n", "two\nt", "hree"]);
});

test("chunkText returns empty array for empty text", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText(null), []);
});

test("extractSearchResults recursively extracts, filters, dedupes, and limits URLs", () => {
  const results = extractSearchResults({
    data: {
      results: [
        { title: "One", url: "https://example.com/one", snippet: "A" },
        { title: "Duplicate", url: "https://example.com/one", snippet: "B" },
        { title: "Invalid", url: "not a url" },
        {
          nested: {
            title: "Two",
            href: "https://example.com/two",
            summary: "Nested result",
          },
        },
        { name: "Three", link: "https://example.com/three" },
        { name: "Four", link: "https://example.com/four" },
      ],
    },
  });

  assert.equal(results.length, 3);
  assert.deepEqual(
    results.map((item) => item.url),
    [
      "https://example.com/one",
      "https://example.com/two",
      "https://example.com/three",
    ]
  );
  assert.equal(results[1].snippet, "Nested result");
});

test("extractSearchResults supports citation fields", () => {
  const results = extractSearchResults({
    results: [
      {
        title: "Cited Source",
        url: "https://example.com/cited",
        citationId: "A1",
      },
    ],
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].citation, "A1");
});

test("extractResearchSummary supports common Anakin response shapes", () => {
  assert.equal(extractResearchSummary({ summary: "Top level" }), "Top level");
  assert.equal(
    extractResearchSummary({ data: { answer: "Nested answer" } }),
    "Nested answer"
  );
  assert.equal(
    extractResearchSummary({ output: { summary: "Output summary" } }),
    "Output summary"
  );
  assert.equal(extractResearchSummary({}), "");
});
