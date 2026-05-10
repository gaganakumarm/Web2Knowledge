const axios = require("axios");

const ANAKIN_API_KEY = process.env.ANAKIN_API_KEY;
const BASE_URL = "https://api.anakin.io/v1";
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 30;
const SCRAPE_ENDPOINTS = ["/url-scraper", "/scrape"];
const DONE_STATUSES = new Set(["completed", "succeeded", "done"]);
const FAILED_STATUSES = new Set(["failed", "error", "cancelled", "canceled"]);

function getHeaders() {
  return {
    "Content-Type": "application/json",
    "X-API-Key": ANAKIN_API_KEY,
    Authorization: `Bearer ${ANAKIN_API_KEY}`,
  };
}

function normalizeScrapeResponse(data, fallbackUrl) {
  const result = data.result || data.data || data.output || data;

  return {
    url: result.url || data.url || fallbackUrl,
    title:
      result.title ||
      data.title ||
      data.metadata?.title ||
      fallbackUrl,
    markdown:
      result.markdown ||
      data.markdown ||
      result.content ||
      result.text ||
      result.cleanedHtml ||
      result.html ||
      data.text ||
      data.cleanedHtml ||
      data.content ||
      "",
    raw: data,
  };
}

function ensureApiKey() {
  if (!ANAKIN_API_KEY || ANAKIN_API_KEY === "your_api_key_here") {
    const error = new Error(
      "Missing Anakin API key. Set ANAKIN_API_KEY in .env to an active key from the Anakin dashboard."
    );
    error.statusCode = 401;
    throw error;
  }
}

function formatAnakinError(error) {
  const status = error.response?.status;
  const data = error.response?.data;
  const message = data?.message || data?.error || error.message;

  if (status === 401 || data?.error === "unauthorized") {
    const authError = new Error(
      "Anakin rejected the API key. Check that ANAKIN_API_KEY in .env is active and belongs to AnakinScraper."
    );
    authError.statusCode = 401;
    return authError;
  }

  const anakinError = new Error(`Anakin API request failed: ${message}`);
  anakinError.statusCode = status || 502;
  return anakinError;
}

function canTryNextEndpoint(error) {
  const status = error.response?.status;
  const data = error.response?.data;
  const message = String(data?.message || data?.error || error.message || "");

  return (
    status === 404 ||
    status === 405 ||
    message.includes("Cannot POST") ||
    message.includes("Method Not Allowed")
  );
}

async function postJson(endpoint, payload) {
  ensureApiKey();

  try {
    const response = await axios.post(`${BASE_URL}${endpoint}`, payload, {
      headers: getHeaders(),
      timeout: 90000,
    });

    return response.data;
  } catch (error) {
    throw formatAnakinError(error);
  }
}

async function postToFirstSupportedEndpoint(endpoints, payload) {
  let lastError;

  for (const endpoint of endpoints) {
    try {
      return await postJson(endpoint, payload);
    } catch (error) {
      lastError = error;

      if (!canTryNextEndpoint(error)) {
        throw error;
      }
    }
  }

  throw lastError;
}

async function getJson(endpoint) {
  ensureApiKey();

  try {
    const response = await axios.get(`${BASE_URL}${endpoint}`, {
      headers: getHeaders(),
      timeout: 30000,
    });

    return response.data;
  } catch (error) {
    throw formatAnakinError(error);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollScrapeJob(jobId) {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const result = await getJson(`/url-scraper/${jobId}`);
    const status = String(result.status || "").toLowerCase();

    if (DONE_STATUSES.has(status)) {
      return result;
    }

    if (FAILED_STATUSES.has(status)) {
      throw new Error(
        result.error || result.message || "Anakin scrape job failed."
      );
    }

    await wait(POLL_INTERVAL_MS);
  }

  throw new Error("Anakin scrape job timed out after 60 seconds.");
}

async function scrapeUrl(url) {
  const data = await postToFirstSupportedEndpoint(SCRAPE_ENDPOINTS, {
    url,
    format: "markdown",
    outputFormat: "markdown",
    formats: ["markdown"],
    render_js: false,
    useBrowser: false,
  });

  const jobId = data.jobId || data.id;

  if (jobId) {
    const status = String(data.status || "").toLowerCase();

    if (DONE_STATUSES.has(status)) {
      return normalizeScrapeResponse(data, url);
    }

    if (FAILED_STATUSES.has(status)) {
      throw new Error(data.error || data.message || "Anakin scrape job failed.");
    }

    return normalizeScrapeResponse(await pollScrapeJob(jobId), url);
  }

  return normalizeScrapeResponse(data, url);
}

async function searchWeb(query) {
  return postJson("/search", {
    query,
    num_results: 5,
    extract_content: false,
    format: "markdown",
  });
}

module.exports = {
  scrapeUrl,
  searchWeb,
};
