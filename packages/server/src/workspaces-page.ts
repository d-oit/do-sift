/**
 * Dependency-free web console for research workspaces (issues #168/#169/#160).
 *
 * The page is static HTML + plain JavaScript served at `/workspaces`. It uses
 * only the documented HTTP routes and the caller's own bearer token: no
 * owner/tenant id is ever sent by the client, and no build step is required.
 *
 * All dynamic content is inserted with `textContent`/`createElement`. Fetched
 * text, answer text, and note bodies are data, never markup or instructions.
 */
export const WORKSPACES_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>do-sift — workspaces</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a2e; }
  h1 { font-size: 1.4rem; } h1 span { color: #6c5ce7; }
  h2 { font-size: 1.05rem; margin-top: 2rem; }
  form { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: .75rem; }
  input, button { padding: .5rem .7rem; font-size: .95rem; }
  input { border: 1px solid #ccc; border-radius: 6px; }
  button { border: 0; border-radius: 6px; background: #6c5ce7; color: #fff; cursor: pointer; }
  button.secondary { background: #ececf6; color: #2d3436; }
  .status { color: #636e72; font-size: .9rem; min-height: 1.2rem; }
  .error { color: #b00020; }
  .card { border: 1px solid #e1e1ec; border-radius: 8px; padding: .8rem 1rem; margin-bottom: .75rem; }
  .card h3 { margin: 0 0 .4rem; font-size: .98rem; }
  .meta { color: #636e72; font-size: .82rem; }
  .excerpt { white-space: pre-wrap; font-size: .9rem; margin-top: .4rem; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0; }
  th, td { text-align: left; border-bottom: 1px solid #e1e1ec; padding: .35rem .45rem; font-size: .88rem; vertical-align: top; }
  .tag { display: inline-block; border-radius: 999px; padding: .05rem .5rem; font-size: .75rem; background: #ececf6; }
  .tag.warn { background: #fff3cd; }
  .tag.bad { background: #fde2e1; }
  ul { padding-left: 1.2rem; }
  .row { display: flex; gap: 1rem; flex-wrap: wrap; }
  .row > section { flex: 1 1 20rem; }
</style>
</head>
<body>
<h1>do-sift <span>— workspaces</span></h1>
<p class="status">Reads and writes use your bearer token; no owner or tenant id is sent by this page.</p>
<form id="auth">
  <input id="token" type="password" placeholder="Bearer token" autocomplete="off" required>
  <button type="submit">Use token</button>
  <button type="button" class="secondary" id="forget">Forget</button>
</form>
<p class="status" id="auth-status"></p>

<div class="row">
  <section>
    <h2>Evidence</h2>
    <form id="evidence-form">
      <button type="submit" class="secondary">Load evidence</button>
    </form>
    <p class="status" id="evidence-status"></p>
    <ul id="evidence-list"></ul>

    <h2>Compare</h2>
    <p class="status">Select 2–8 evidence ids above, then compare stored passages.</p>
    <form id="compare-form">
      <button type="submit">Compare selected</button>
    </form>
    <p class="status" id="compare-status"></p>
    <div id="compare-result"></div>

    <h2>Report export</h2>
    <p class="status">Exports the loaded (or selected) evidence metadata. No claims are invented, and no owner note is attached.</p>
    <form id="report-form">
      <select id="report-format">
        <option value="markdown">Markdown</option>
        <option value="json">JSON</option>
        <option value="html">HTML</option>
        <option value="bibtex">BibTeX</option>
      </select>
      <button type="submit">Download report</button>
    </form>
    <p class="status" id="report-status"></p>
  </section>

  <section>
    <h2>Collections</h2>
    <form id="collection-form">
      <input id="collection-title" placeholder="Collection title" required maxlength="200">
      <button type="submit">Create</button>
    </form>
    <p class="status" id="collection-status"></p>
    <div id="collection-list"></div>
    <div id="collection-detail"></div>

    <h2>Answer receipt</h2>
    <form id="answer-form">
      <input id="answer-question" placeholder="Ask a question…" required>
      <button type="submit">Answer</button>
    </form>
    <p class="status" id="answer-status"></p>
    <div id="answer-result"></div>
  </section>
</div>

<script>
  "use strict";
  const $ = (id) => document.getElementById(id);
  const el = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const setStatus = (id, text, isError) => {
    const node = $(id);
    node.textContent = text;
    node.className = isError ? "status error" : "status";
  };
  const tag = (text, kind) => {
    const node = el("span", text);
    node.className = kind ? "tag " + kind : "tag";
    return node;
  };

  const stored = sessionStorage.getItem("do-sift-token");
  if (stored) $("token").value = stored;
  $("auth").addEventListener("submit", (event) => {
    event.preventDefault();
    sessionStorage.setItem("do-sift-token", $("token").value.trim());
    setStatus("auth-status", "Token stored for this tab.");
  });
  $("forget").addEventListener("click", () => {
    sessionStorage.removeItem("do-sift-token");
    $("token").value = "";
    setStatus("auth-status", "Token forgotten.");
  });

  async function api(path, init) {
    const headers = Object.assign({}, init && init.headers);
    const token = $("token").value.trim();
    if (token) headers.authorization = "Bearer " + token;
    if (init && init.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(path, Object.assign({}, init, { headers }));
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text };
    }
    if (!response.ok) {
      throw new Error((data && data.message) || "HTTP " + response.status);
    }
    return data;
  }

  async function exportReport(body, format) {
    const token = $("token").value.trim();
    const response = await fetch("/api/reports/export", {
      method: "POST",
      headers: Object.assign(
        { "content-type": "application/json" },
        token ? { authorization: "Bearer " + token } : {},
      ),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      let message = "HTTP " + response.status;
      try {
        message = JSON.parse(text).message || message;
      } catch {
        message = text || message;
      }
      throw new Error(message);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download =
      "report." + (format === "markdown" ? "md" : format === "bibtex" ? "bib" : format);
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function link(url, label) {
    const a = el("a", label || url);
    a.href = url;
    a.target = "_blank";
    a.rel = "noreferrer noopener";
    return a;
  }

  function observationCard(source) {
    const card = el("div");
    card.className = "card";
    const heading = el("h3");
    heading.appendChild(link(source.url, source.title || source.url));
    card.appendChild(heading);
    const meta = el("div");
    meta.className = "meta";
    meta.textContent =
      (source.publisher ? source.publisher + " · " : "") +
      "retrieved " + source.retrievedAt +
      (source.publishedAt ? " · published " + source.publishedAt : " · published unknown") +
      (source.contentHash ? " · hash " + source.contentHash.slice(0, 16) : "");
    card.appendChild(meta);
    const excerpt = el("div", source.excerpt);
    excerpt.className = "excerpt";
    card.appendChild(excerpt);
    return card;
  }

  let evidenceIds = [];
  let evidenceRows = [];
  $("evidence-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const list = $("evidence-list");
    list.replaceChildren();
    evidenceIds = [];
    try {
      const data = await api("/api/evidence?limit=25");
      const rows = data.evidence || [];
      evidenceRows = rows;
      setStatus("evidence-status", rows.length + " evidence row(s)");
      rows.forEach((row) => {
        evidenceIds.push(row.id);
        const item = el("li");
        const label = el("label");
        const box = el("input");
        box.type = "checkbox";
        box.value = row.id;
        label.appendChild(box);
        label.appendChild(el("span", " " + (row.title || row.url)));
        item.appendChild(label);
        const meta = el("div", row.fetchedAt + " · id " + row.id);
        meta.className = "meta";
        item.appendChild(meta);
        list.appendChild(item);
      });
    } catch (error) {
      setStatus("evidence-status", String(error.message), true);
    }
  });

  $("compare-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const selected = Array.from(document.querySelectorAll("#evidence-list input:checked")).map(
      (box) => box.value,
    );
    const result = $("compare-result");
    result.replaceChildren();
    if (selected.length < 2 || selected.length > 8) {
      setStatus("compare-status", "Select 2–8 evidence ids.", true);
      return;
    }
    try {
      const data = await api("/api/compare", {
        method: "POST",
        body: JSON.stringify({ ids: selected }),
      });
      setStatus("compare-status", "Schema v" + data.comparison.schemaVersion);
      const notice = el("p", data.comparison.notice);
      notice.className = "meta";
      result.appendChild(notice);
      data.comparison.sources.forEach((source) => result.appendChild(observationCard(source)));
      const observations = el("ul");
      data.comparison.observations.forEach((observation) => {
        observations.appendChild(el("li", observation.kind + ": " + observation.note));
      });
      result.appendChild(observations);
    } catch (error) {
      setStatus("compare-status", String(error.message), true);
    }
  });

  $("report-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const selected = Array.from(document.querySelectorAll("#evidence-list input:checked")).map(
      (box) => box.value,
    );
    const ids = selected.length > 0 ? selected : evidenceIds;
    if (ids.length === 0) {
      setStatus("report-status", "Load or select evidence first.", true);
      return;
    }
    const format = $("report-format").value;
    const sources = evidenceRows
      .filter((row) => ids.includes(row.id))
      .map((row) => {
        const source = { id: row.id, url: row.url, fetchedAt: row.fetchedAt };
        if (row.title) source.title = row.title;
        return source;
      });
    try {
      await exportReport(
        {
          format: format,
          report: { schemaVersion: 1, sources: sources, claims: [], annotations: [] },
        },
        format,
      );
      setStatus("report-status", "Downloaded " + sources.length + " source(s) as " + format + ".");
    } catch (error) {
      setStatus("report-status", String(error.message), true);
    }
  });

  async function loadCollections() {
    const list = $("collection-list");
    list.replaceChildren();
    try {
      const data = await api("/api/collections?limit=50");
      setStatus("collection-status", (data.collections || []).length + " collection(s)");
      (data.collections || []).forEach((collection) => {
        const card = el("div");
        card.className = "card";
        card.appendChild(el("h3", collection.title));
        if (collection.description) card.appendChild(el("div", collection.description));
        const meta = el("div", "id " + collection.id + " · updated " + collection.updatedAt);
        meta.className = "meta";
        card.appendChild(meta);
        const open = el("button", "Open");
        open.type = "button";
        open.className = "secondary";
        open.addEventListener("click", () => openCollection(collection.id));
        card.appendChild(open);
        list.appendChild(card);
      });
    } catch (error) {
      setStatus("collection-status", String(error.message), true);
    }
  }

  $("collection-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/collections", {
        method: "POST",
        body: JSON.stringify({ title: $("collection-title").value.trim() }),
      });
      $("collection-title").value = "";
      await loadCollections();
    } catch (error) {
      setStatus("collection-status", String(error.message), true);
    }
  });

  async function openCollection(id) {
    const detail = $("collection-detail");
    detail.replaceChildren();
    try {
      const data = await api("/api/collections/" + encodeURIComponent(id));
      const card = el("div");
      card.className = "card";
      card.appendChild(el("h3", data.collection.title));
      const meta = el("div", "id " + data.collection.id + " · " + data.items.length + " item(s)");
      meta.className = "meta";
      card.appendChild(meta);

      const reportButton = el("button", "Download collection report");
      reportButton.type = "button";
      reportButton.className = "secondary";
      reportButton.addEventListener("click", async () => {
        const format = $("report-format").value;
        try {
          // Stored metadata makes this independent of the evidence list.
          await exportReport(
            { format: format, collectionId: id, includeAnnotations: true },
            format,
          );
          setStatus("collection-status", "Downloaded collection report as " + format + ".");
        } catch (error) {
          setStatus("collection-status", String(error.message), true);
        }
      });
      card.appendChild(reportButton);

      const items = el("ul");
      data.items.forEach((item) => items.appendChild(el("li", item.kind + " · " + item.id)));
      if (data.items.length === 0) items.appendChild(el("li", "No items yet."));
      card.appendChild(items);

      const itemForm = el("form");
      const itemInput = el("input");
      itemInput.placeholder = "Existing evidence id";
      itemInput.required = true;
      const itemButton = el("button", "Attach evidence");
      itemButton.className = "secondary";
      itemForm.appendChild(itemInput);
      itemForm.appendChild(itemButton);
      itemForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
          await api("/api/collections/" + encodeURIComponent(id) + "/items", {
            method: "POST",
            body: JSON.stringify({ kind: "evidence", id: itemInput.value.trim() }),
          });
          await openCollection(id);
        } catch (error) {
          setStatus("collection-status", String(error.message), true);
        }
      });
      card.appendChild(itemForm);

      data.notes.forEach((note) => {
        const noteCard = el("div");
        noteCard.className = "card";
        noteCard.appendChild(el("div", note.body));
        const noteMeta = el("div", note.authorId + " · " + note.createdAt);
        noteMeta.className = "meta";
        noteCard.appendChild(noteMeta);
        const remove = el("button", "Delete note");
        remove.type = "button";
        remove.className = "secondary";
        remove.addEventListener("click", async () => {
          try {
            await api(
              "/api/collections/" + encodeURIComponent(id) + "/notes/" + encodeURIComponent(note.id),
              { method: "DELETE" },
            );
            await openCollection(id);
          } catch (error) {
            setStatus("collection-status", String(error.message), true);
          }
        });
        noteCard.appendChild(remove);
        card.appendChild(noteCard);
      });

      const noteForm = el("form");
      const noteInput = el("input");
      noteInput.placeholder = "Owner note (never treated as evidence)";
      noteInput.required = true;
      const noteButton = el("button", "Add note");
      noteButton.className = "secondary";
      noteForm.appendChild(noteInput);
      noteForm.appendChild(noteButton);
      noteForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
          await api("/api/collections/" + encodeURIComponent(id) + "/notes", {
            method: "POST",
            body: JSON.stringify({ body: noteInput.value }),
          });
          await openCollection(id);
        } catch (error) {
          setStatus("collection-status", String(error.message), true);
        }
      });
      card.appendChild(noteForm);
      detail.appendChild(card);
    } catch (error) {
      setStatus("collection-status", String(error.message), true);
    }
  }

  $("answer-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = $("answer-result");
    result.replaceChildren();
    try {
      const data = await api("/api/answer", {
        method: "POST",
        body: JSON.stringify({ question: $("answer-question").value.trim() }),
      });
      const badges = el("p");
      if (data.cached) badges.appendChild(tag("cached"));
      if (data.degraded) badges.appendChild(tag("degraded " + (data.degradationReason || ""), "warn"));
      if (data.evidenceOnly) badges.appendChild(tag("evidence-only", "warn"));
      result.appendChild(badges);
      const assessment = data.claimAssessment;
      if (!assessment) {
        result.appendChild(el("p", "No claim assessment in this response."));
        return;
      }
      const summary = assessment.summary;
      setStatus(
        "answer-status",
        summary.claims +
          " claim(s) · supported " + summary.supported +
          " · partial " + summary.partiallySupported +
          " · unresolved " + summary.unresolved +
          " · no citation " + summary.noCitation,
      );
      const table = el("table");
      const head = el("tr");
      ["#", "support", "resolved", "unresolved"].forEach((name) =>
        head.appendChild(el("th", name)),
      );
      table.appendChild(head);
      assessment.claims.forEach((claim) => {
        const row = el("tr");
        row.appendChild(el("td", String(claim.index + 1)));
        const support = el("td");
        support.appendChild(
          tag(
            claim.support,
            claim.support === "supported"
              ? ""
              : claim.support === "partially-supported"
                ? "warn"
                : "bad",
          ),
        );
        row.appendChild(support);
        row.appendChild(el("td", claim.resolved.join(", ") || "—"));
        row.appendChild(el("td", claim.unresolved.join(", ") || "—"));
        table.appendChild(row);
      });
      result.appendChild(table);
      const note = el("p", "Supported means every cited id exists; it is not an entailment verdict.");
      note.className = "meta";
      result.appendChild(note);
    } catch (error) {
      setStatus("answer-status", String(error.message), true);
    }
  });

  loadCollections();
</script>
</body>
</html>`;
