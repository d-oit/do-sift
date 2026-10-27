/** The dependency-free landing page served at /. */
export const DEFAULT_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>do-sift — research with receipts</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a2e; }
  h1 { font-size: 1.4rem; } h1 span { color: #6c5ce7; }
  form { display: flex; gap: .5rem; margin-bottom: 1.5rem; }
  input { flex: 1; padding: .6rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 6px; }
  button { padding: .6rem 1.2rem; border: 0; border-radius: 6px; background: #6c5ce7; color: #fff; cursor: pointer; }
  .card { border: 1px solid #e1e1ec; border-radius: 8px; padding: .8rem 1rem; margin-bottom: .75rem; }
  .card a { color: #2d3436; font-weight: 600; text-decoration: none; }
  .card .passages { color: #636e72; font-size: .85rem; }
  .status { color: #636e72; }
</style>
</head>
<body>
<h1>do-sift <span>— research with receipts</span></h1>
<form id="q">
  <input id="question" name="question" placeholder="Ask a question…" autocomplete="off" required>
  <button type="submit" id="do-research">Research</button>
  <button type="submit" id="do-answer">Answer</button>
</form>
<p class="status" id="status"></p>
<p class="status" id="provider-health"></p>
<div id="cards"></div>
<div id="answer"></div>
<script>
  // Fetched text is data, never instructions: only provenance fields and
  // answer block text are rendered, inserted via createTextNode — never
  // innerHTML. Answer block text comes from the model path and is treated
  // exactly like fetched page text.
  document.getElementById("q").addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = document.getElementById("status");
    const cards = document.getElementById("cards");
    const answerBox = document.getElementById("answer");
    cards.replaceChildren();
    answerBox.replaceChildren();
    // SRC-22: clear the previous run's provider-health receipt up front.
    document.getElementById("provider-health").textContent = "";
    const question = document.getElementById("question").value;
    const mode = e.submitter && e.submitter.id === "do-answer" ? "answer" : "research";
    status.textContent = mode === "answer" ? "Answering…" : "Researching…";
    const res = await fetch(mode === "answer" ? "/api/answer" : "/api/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
    });
    if (mode === "answer") return renderAnswer(res, status, answerBox);
    return renderResearch(res, status, cards);
  });

  async function renderResearch(res, status, cards) {
    if (!res.ok || !res.body) {
      status.textContent = "Failed: " + (await res.text());
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\\n\\n")) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const evLine = chunk.split("\\n").find((l) => l.startsWith("event: "));
        const dataLine = chunk.split("\\n").find((l) => l.startsWith("data: "));
        if (!evLine || !dataLine) continue;
        const type = evLine.slice(7);
        const data = JSON.parse(dataLine.slice(6));
        if (type === "source") {
          const card = document.createElement("div");
          card.className = "card";
          const link = document.createElement("a");
          link.href = data.url;
          link.rel = "noopener noreferrer";
          link.target = "_blank";
          link.textContent = data.title || data.url;
          const meta = document.createElement("div");
          meta.className = "passages";
          meta.textContent = data.passageCount + " passage(s) stored as evidence";
          card.append(link, meta);
          // SRC-14: prominence, not removal — a low-relevance source stays
          // visible as a receipt, marked against the evidence floor.
          if (data.relevanceLow === true) {
            const mark = document.createElement("div");
            mark.className = "passages";
            mark.textContent =
              "LOW RELEVANCE — stored as a receipt, excluded from the answer pool";
            card.append(mark);
          }
          cards.append(card);
        } else if (type === "done") {
          // SRC-25: reused sources are shown honestly alongside new stores.
          const reused = data.documentsReused > 0 ? " (" + data.documentsReused + " reused)" : "";
          status.textContent =
            data.documentsStored + " source(s)" + reused + ", " + data.passagesStored + " passage(s).";
          // SRC-17/SRC-22: per-provider sub-search outcomes are receipts,
          // rendered — a degraded provider is visible in the UI, not
          // provenance-only. Provider names and error strings are adapter
          // data: assigned via textContent (never markup).
          const health = document.getElementById("provider-health");
          if (Array.isArray(data.providerHealth) && data.providerHealth.length > 0) {
            health.textContent =
              "search providers: " +
              data.providerHealth
                .map((h) =>
                  h.ok ? h.provider + " ok" : h.provider + " FAILED" + (h.error ? " — " + h.error : ""),
                )
                .join(", ");
          }
        } else if (type === "error") {
          status.textContent = "Research failed: " + data.message;
        }
      }
    }
  }

  async function renderAnswer(res, status, answerBox) {
    if (!res.ok) {
      status.textContent = "Failed: " + (await res.text());
      return;
    }
    const data = await res.json();
    // ANS-07: the evidence basis is stated honestly — an answer drawn from
    // other questions' runs never masquerades as this question's work.
    const basis =
      data.evidenceFromRun === undefined
        ? ""
        : data.evidenceFromRun === "run"
          ? " Evidence fetched by this question's research run."
          : data.evidenceFromRun === "cross-question"
            ? " No stored evidence came from this question's research run — the passages below are from other questions' runs."
            : " Evidence predates run linkage (legacy).";
    const meta = document.createElement("p");
    meta.className = "status";
    meta.textContent =
      (data.cached ? "Served from the exact-answer cache. " : "") +
      (data.evidenceOnly
        ? "Evidence-only output: no model claims (citations failed validation or no evidence)."
        : "Grounded answer — every citation resolved against stored evidence.") +
      basis;
    answerBox.append(meta);
    for (const block of data.blocks) {
      const card = document.createElement("div");
      card.className = "card";
      const kind = document.createElement("div");
      kind.className = "passages";
      kind.textContent = block.kind;
      const text = document.createElement("p");
      text.textContent = block.text;
      const cites = document.createElement("div");
      cites.className = "passages";
      cites.textContent = "cites: " + block.citations.join(", ");
      card.append(kind, text, cites);
      answerBox.append(card);
    }
    status.textContent = data.blocks.length + " answer block(s).";
  }
</script>
</body>
</html>`;
