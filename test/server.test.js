const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const {
  app,
  chunkText,
  extractResearchSummary,
  extractSearchResults,
  isValidHttpUrl,
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

test("URL validation accepts only http and https URLs", () => {
  assert.equal(isValidHttpUrl("https://tailwindcss.com/docs"), true);
  assert.equal(isValidHttpUrl("http://example.com"), true);
  assert.equal(isValidHttpUrl("Next.js routing"), false);
  assert.equal(isValidHttpUrl("ftp://example.com"), false);
  assert.equal(isValidHttpUrl(""), false);
});

test("chunkText cleans excessive blank lines and chunks content", () => {
  const chunks = chunkText("one\n\n\n\ntwo\nthree", 5);

  assert.deepEqual(chunks, ["one\n\n", "two\nt", "hree"]);
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
});
