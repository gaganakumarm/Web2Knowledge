const appState = {
  sources: 0,
  chunks: 0,
  lastResultCount: 0,
  hasBuilt: false,
  isBuilding: false,
  pipelineTimer: null,
  pipelineStage: 0,
  results: [],
  sourcesList: [],
  researchSummary: "",
};

const pipelineStages = ["Discover", "Extract", "Chunk", "Ready"];

renderPipelineStages();
renderEmptyState("Start by building a knowledge base from a URL or topic.");
syncModeControls();
updateControls();
loadSavedDataset();

async function loadSavedDataset() {
  try {
    const res = await fetch("/api/search");
    const data = await res.json();
    const results = data.results || [];
    const total = Number(data.total || results.length || 0);

    appState.results = results;
    appState.hasBuilt = total > 0;
    updateStats({ sources: 0, chunks: total, results: results.length });
    updateSourcesHint(total > 0 ? "Saved dataset" : "Current build");
    updateDatasetState();
    updateControls();

    if (total > 0) {
      setStatus("Loaded", `Saved dataset available with ${total} chunk${total === 1 ? "" : "s"}. Sources are shown only after a fresh build.`, "success");
      updateResultCount(results.length, "");
      renderActiveTab();
      return;
    }

    setStatus("Ready", "Build or load a dataset to begin.", "idle");
    updateResultCount(0, "");
  } catch (err) {
    setStatus("Offline", "Could not load saved dataset.", "error");
  }
}

async function buildKB() {
  const input = document.getElementById("input").value.trim();
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const researchMode = document.querySelector('input[name="researchMode"]:checked').value;
  const extractionMode = document.querySelector('input[name="extractionMode"]:checked').value;
  const isTopicMode = mode === "topic" || !isHttpUrl(input);

  if (!input) {
    setStatus("Missing Input", "Please enter a URL or topic.", "error");
    return;
  }

  setBuilding(true);
  appState.hasBuilt = false;
  appState.results = [];
  appState.sourcesList = [];
  appState.researchSummary = "";
  clearAnswer();
  document.getElementById("search").value = "";
  document.getElementById("question").value = "";
  updateStats({ sources: 0, chunks: 0, results: 0 });
  updateResultCount(0, "");
  renderEmptyState("Building dataset...");
  setStatus("Building", getLoadingMessage(isTopicMode, researchMode), "loading");

  if (isTopicMode) {
    startPipeline(researchMode === "agentic");
  } else {
    stopPipeline();
  }

  try {
    const res = await fetch(isTopicMode ? "/api/topic-build" : "/api/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, mode, researchMode, extractionMode }),
    });
    const data = await res.json();

    if (!res.ok) {
      const message = data.details || data.error || "Build failed.";
      stopPipeline();
      setStatus("Build Failed", message, "error");
      renderEmptyState("The build did not complete. Check the input and try again.");
      return;
    }

    appState.hasBuilt = true;
    appState.sourcesList = data.discoveredSources || data.urls.map((url) => ({ title: url, url, snippet: "" }));
    appState.researchSummary = data.researchSummary || "";
    stopPipeline("Ready");
    updateStats({
      sources: data.totalSourcesDiscovered || data.urls.length,
      chunks: data.totalChunks,
      results: 0,
    });
    updateSourcesHint("Current build");

    const failedCount = (data.failedSources || []).length;
    const fallbackText = data.agenticFallback ? " Agentic fallback used." : "";
    const skippedText = failedCount ? ` ${failedCount} source${failedCount === 1 ? "" : "s"} skipped.` : "";
    setStatus("Complete", `Created ${data.totalChunks} chunk${data.totalChunks === 1 ? "" : "s"}.${skippedText}${fallbackText}`, "success");
    updateDatasetState();
    await searchKB();
  } catch (err) {
    stopPipeline();
    setStatus("Request Failed", "The browser could not reach the backend.", "error");
    renderEmptyState("Make sure the server is running, then try again.");
  } finally {
    setBuilding(false);
  }
}

async function searchKB() {
  const q = document.getElementById("search").value.trim();
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  const data = await res.json();
  const results = data.results || [];

  appState.results = results;
  updateStats({ results: results.length });
  updateResultCount(results.length, q);
  renderActiveTab();
}

async function askKB() {
  const question = document.getElementById("question").value.trim();

  if (!question) {
    setStatus("Missing Question", "Please enter a question.", "error");
    return;
  }

  document.getElementById("askButton").disabled = true;

  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();

    if (!res.ok) {
      setStatus("Ask Failed", data.error || "Question failed.", "error");
      return;
    }

    renderAnswer(data);
  } catch (err) {
    setStatus("Ask Failed", "The browser could not reach the backend.", "error");
  } finally {
    updateControls();
  }
}

async function clearDataset() {
  document.getElementById("clearButton").disabled = true;

  try {
    const res = await fetch("/api/dataset", { method: "DELETE" });
    const data = await res.json();

    if (!res.ok) {
      setStatus("Clear Failed", data.error || "Could not clear dataset.", "error");
      return;
    }

    appState.hasBuilt = false;
    appState.results = [];
    appState.sourcesList = [];
    appState.researchSummary = "";
    document.getElementById("search").value = "";
    document.getElementById("question").value = "";
    clearAnswer();
    updateStats({ sources: 0, chunks: 0, results: 0 });
    updateSourcesHint("Current build");
    updateDatasetState();
    updateResultCount(0, "");
    renderEmptyState("Start by building a knowledge base from a URL or topic.");
    setStatus("Cleared", "Dataset cleared.", "success");
  } catch (err) {
    setStatus("Clear Failed", "The browser could not reach the backend.", "error");
  } finally {
    updateControls();
  }
}

function renderActiveTab() {
  const activeTab = document.querySelector('input[name="activeTab"]:checked').value;

  if (activeTab === "sources") {
    renderSources();
    return;
  }

  if (activeTab === "summary") {
    renderSummary();
    return;
  }

  renderResults();
}

function renderResults() {
  const results = appState.results;

  if (results.length === 0) {
    if (!appState.hasBuilt) {
      renderEmptyState("Build a dataset first.");
    } else if (document.getElementById("search").value.trim()) {
      renderEmptyState("No matching chunks found.");
    } else {
      renderEmptyState("No chunks are available.");
    }
    return;
  }

  document.getElementById("workspace").innerHTML = results
    .map((item) => {
      const preview = item.content.length > 720 ? `${item.content.slice(0, 720)}...` : item.content;
      const score = typeof item.score === "number" ? `<span class="score-pill">Score ${item.score.toFixed(2)}</span>` : "";

      return `
        <article class="result-card">
          <div class="result-card-header">
            <div>
              <p class="chunk-label">Chunk ${Number(item.chunkIndex) + 1}</p>
              <h3>${escapeHtml(item.title)}</h3>
            </div>
            <div class="result-actions">
              ${score}
              <a href="${escapeAttribute(item.source)}" target="_blank" class="source-link">Source</a>
            </div>
          </div>
          <p class="result-preview">${escapeHtml(preview)}</p>
          <p class="source-url">${escapeHtml(item.source)}</p>
        </article>
      `;
    })
    .join("");
}

function renderSources() {
  if (appState.sourcesList.length === 0) {
    renderEmptyState(appState.hasBuilt ? "Source details are available after a fresh build. Saved datasets keep chunks, search, ask, and export." : "Build a dataset first.");
    return;
  }

  document.getElementById("workspace").innerHTML = appState.sourcesList
    .map((source, index) => {
      const snippet = source.snippet && source.snippet.length > 260 ? `${source.snippet.slice(0, 260)}...` : source.snippet;

      return `
        <a href="${escapeAttribute(source.url)}" target="_blank" class="source-card">
          <p class="source-label">Source ${index + 1}</p>
          <h3>${escapeHtml(source.title || source.url)}</h3>
          <p class="source-url">${escapeHtml(source.url)}</p>
          ${source.citation ? `<p class="chunk-label">Citation ${escapeHtml(source.citation)}</p>` : ""}
          ${snippet ? `<p class="source-snippet">${escapeHtml(snippet)}</p>` : ""}
        </a>
      `;
    })
    .join("");
}

function renderSummary() {
  if (!appState.researchSummary) {
    renderEmptyState(appState.hasBuilt ? "No research summary is available for this dataset." : "Build a dataset first.");
    return;
  }

  document.getElementById("workspace").innerHTML = `
    <article class="summary-card">
      <p>${escapeHtml(appState.researchSummary)}</p>
    </article>
  `;
}

function renderAnswer(data) {
  document.getElementById("answerPanel").classList.remove("hidden");
  document.getElementById("answerText").textContent = data.answer;
  document.getElementById("answerCitations").innerHTML = (data.citations || [])
    .map((citation, index) => `
      <a href="${escapeAttribute(citation.source)}" target="_blank" class="citation-link">
        Source ${index + 1}: ${escapeHtml(citation.title)}
      </a>
    `)
    .join("");
}

function renderEmptyState(message) {
  document.getElementById("workspace").innerHTML = `
    <div class="empty-state">
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

function renderPipelineStages() {
  document.getElementById("pipelineStages").innerHTML = pipelineStages
    .map((stage, index) => `
      <div id="pipelineStage${index}" class="pipeline-stage">
        ${stage}
      </div>
    `)
    .join("");
}

function startPipeline(isAgentic) {
  document.getElementById("pipelinePanel").classList.remove("hidden");
  appState.pipelineStage = 0;
  setPipelineStage(0);
  clearInterval(appState.pipelineTimer);
  appState.pipelineTimer = setInterval(() => {
    appState.pipelineStage = Math.min(appState.pipelineStage + 1, pipelineStages.length - 1);
    setPipelineStage(appState.pipelineStage);
  }, isAgentic ? 2600 : 2000);
}

function stopPipeline(finalStage) {
  clearInterval(appState.pipelineTimer);
  appState.pipelineTimer = null;

  if (finalStage) {
    setPipelineStage(pipelineStages.indexOf(finalStage));
    return;
  }

  document.getElementById("pipelinePanel").classList.add("hidden");
}

function setPipelineStage(activeIndex) {
  const safeIndex = Math.max(0, activeIndex);

  pipelineStages.forEach((stage, index) => {
    const item = document.getElementById(`pipelineStage${index}`);
    const isActive = index === safeIndex;
    const isDone = index < safeIndex;
    item.className = isActive
      ? "pipeline-stage active"
      : isDone
        ? "pipeline-stage done"
        : "pipeline-stage";
  });
}

function setBuilding(isBuilding) {
  appState.isBuilding = isBuilding;
  document.getElementById("buildButton").disabled = isBuilding;
  document.getElementById("buildSpinner").classList.toggle("hidden", !isBuilding);
  document.getElementById("buildButtonText").textContent = isBuilding ? "Building..." : "Build Knowledge Base";
  updateControls();
}

function setStatus(label, message, type) {
  const statusLabel = document.getElementById("statusLabel");
  const status = document.getElementById("status");
  const colors = {
    success: "text-emerald-300",
    error: "text-rose-300",
    loading: "text-teal-200",
    idle: "text-slate-300",
  };

  statusLabel.className = `status-label ${colors[type] || colors.idle}`;
  statusLabel.textContent = label;
  status.className = "status-message";
  status.textContent = message;
}

function syncModeControls() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const isTopicMode = mode === "topic";
  const extractionFieldset = document.getElementById("extractionFieldset");
  const extractionHint = document.getElementById("extractionHint");
  const modeHelper = document.getElementById("modeHelper");

  extractionFieldset.classList.toggle("opacity-45", isTopicMode);
  extractionFieldset.querySelectorAll("input").forEach((input) => {
    input.disabled = isTopicMode;
  });

  extractionHint.textContent = isTopicMode
    ? "Topic builds ignore extraction mode and discover sources automatically."
    : "Single URL is fastest. Site Crawl extracts a small multi-page sample.";
  modeHelper.textContent = isTopicMode
    ? "Topic mode calls /api/topic-build. Use Standard for fast discovery or Deep for Agentic Search with fallback."
    : "URL mode calls /api/build. Paste a public http/https URL and choose Single URL or Site Crawl.";
}

function useExample(type) {
  if (type === "url") {
    document.getElementById("input").value = "https://tailwindcss.com/docs";
    document.querySelector('input[name="mode"][value="url"]').checked = true;
    document.querySelector('input[name="extractionMode"][value="scrape"]').checked = true;
    document.querySelector('input[name="researchMode"][value="standard"]').checked = true;
    setStatus("Ready", "Tailwind URL loaded. Click Build Knowledge Base.", "idle");
  }

  if (type === "topic") {
    document.getElementById("input").value = "AI agents for software development";
    document.querySelector('input[name="mode"][value="topic"]').checked = true;
    document.querySelector('input[name="researchMode"][value="standard"]').checked = true;
    setStatus("Ready", "Topic loaded. Click Build Knowledge Base.", "idle");
  }

  if (type === "ask") {
    document.getElementById("question").value = appState.chunks > 0
      ? "What is this dataset about?"
      : "What is Tailwind CSS?";
    setStatus("Ready", appState.chunks > 0 ? "Sample question loaded." : "Build a dataset before asking.", "idle");
  }

  syncModeControls();
}

function updateControls() {
  document.getElementById("askButton").disabled = appState.isBuilding || appState.chunks === 0;
  document.getElementById("clearButton").disabled = appState.isBuilding || appState.chunks === 0;
}

function updateDatasetState() {
  const badge = document.getElementById("datasetBadge");
  const state = document.getElementById("datasetState");

  if (appState.chunks > 0) {
    badge.className = "rounded-md border border-emerald-300/30 bg-emerald-300/10 px-2 py-1 text-xs font-semibold text-emerald-200";
    badge.textContent = "Ready";
    state.textContent = `${appState.chunks} chunk${appState.chunks === 1 ? "" : "s"} available`;
    return;
  }

  badge.className = "rounded-md border border-slate-600 bg-slate-800 px-2 py-1 text-xs font-semibold text-slate-300";
  badge.textContent = "Idle";
  state.textContent = "No active dataset";
}

function updateStats(next) {
  if (typeof next.sources === "number") appState.sources = next.sources;
  if (typeof next.chunks === "number") appState.chunks = next.chunks;
  if (typeof next.results === "number") appState.lastResultCount = next.results;

  document.getElementById("sourcesStat").textContent = appState.sources;
  document.getElementById("chunksStat").textContent = appState.chunks;
  document.getElementById("resultsStat").textContent = appState.lastResultCount;
  updateDatasetState();
  updateControls();
}

function updateSourcesHint(message) {
  document.getElementById("sourcesHint").textContent = message;
}

function updateResultCount(count, query) {
  const resultCount = document.getElementById("resultCount");

  if (!appState.hasBuilt) {
    resultCount.textContent = "Build a dataset to start searching.";
    return;
  }

  resultCount.textContent = query
    ? `${count} result${count === 1 ? "" : "s"} for "${query}"`
    : `${count} result${count === 1 ? "" : "s"} shown`;
}

function clearAnswer() {
  document.getElementById("answerPanel").classList.add("hidden");
  document.getElementById("answerText").textContent = "";
  document.getElementById("answerCitations").innerHTML = "";
}

function getLoadingMessage(isTopicMode, researchMode) {
  const extractionMode = document.querySelector('input[name="extractionMode"]:checked').value;
  if (!isTopicMode && extractionMode === "crawl") return "Crawling site pages and preparing chunks...";
  if (!isTopicMode) return "Scraping source and preparing chunks...";
  if (researchMode === "agentic") return "Running deep research and building context...";
  return "Searching sources and building context...";
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(text) {
  return escapeHtml(text).replaceAll("`", "&#096;");
}
