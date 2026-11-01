import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface QualityCase {
  id: string;
  question: string;
  scores: Record<string, number | string | null>;
  notes?: string[];
  providerHealth?: Array<{ provider: string; ok: boolean }>;
  sources?: Array<{ url: string; relevanceScore: number; low: boolean }>;
}

export interface QualityRun {
  runId: string;
  protocol?: string;
  executedAtUtc?: string;
  pipeline?: string;
  aggregates?: Record<string, number | null | string>;
  limits?: string[];
  findings?: string[];
  cases?: QualityCase[];
  comparison?: {
    baseline?: string;
    verdict?: string;
    perDimension?: Record<string, string>;
  };
  providerHealthSummary?: Record<string, unknown>;
}

export const DIMENSIONS = [
  "retrievalRelevance",
  "extractionCleanliness",
  "citationResolution",
  "degradationHonesty",
  "injectionObservation",
] as const;

export type DimensionKey = (typeof DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<DimensionKey, string> = {
  retrievalRelevance: "Retrieval Relevance",
  extractionCleanliness: "Extraction Cleanliness",
  citationResolution: "Citation Resolution",
  degradationHonesty: "Degradation Honesty",
  injectionObservation: "Injection Observation",
};

/**
 * Loads and sorts all runs from the quality directory.
 */
export function loadQualityRuns(qualityDir: string): QualityRun[] {
  if (!existsSync(qualityDir)) return [];
  const files = readdirSync(qualityDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  const runs: QualityRun[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(qualityDir, file), "utf8");
      const parsed = JSON.parse(content) as QualityRun;
      runs.push(parsed);
    } catch (err) {
      console.warn(`Failed parsing ${file}:`, err);
    }
  }

  // Sort by run number extracted from runId or filename
  runs.sort((a, b) => {
    const numA = Number.parseInt(a.runId?.replace(/\D/g, "") || "0", 10);
    const numB = Number.parseInt(b.runId?.replace(/\D/g, "") || "0", 10);
    return numA - numB;
  });

  return runs;
}

/**
 * Calculates a summary score for a case (average of operative numeric dimension scores).
 */
export function getCaseScore(
  scores: Record<string, number | string | null> | undefined,
): number | null {
  if (!scores) return null;
  const numericScores: number[] = [];
  for (const dim of DIMENSIONS) {
    const val = scores[dim];
    if (typeof val === "number" && !Number.isNaN(val)) {
      numericScores.push(val);
    }
  }
  if (numericScores.length === 0) return null;
  return numericScores.reduce((acc, v) => acc + v, 0) / numericScores.length;
}

/**
 * Generates an SVG line chart plotting the mean score per run.
 */
export function generateTrendChartSvg(runs: QualityRun[]): string {
  const width = 850;
  const height = 300;
  const padding = { top: 40, right: 30, bottom: 50, left: 60 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const data = runs.map((r, idx) => {
    const rawScore = r.aggregates?.meanAll ?? r.aggregates?.meanOperative;
    const score = typeof rawScore === "number" ? rawScore : null;
    return {
      runId: r.runId,
      date: r.executedAtUtc?.slice(0, 10) ?? "",
      score,
      idx,
    };
  });

  const validPoints = data.filter((d) => d.score !== null);
  if (validPoints.length === 0) {
    return `<svg width="${width}" height="${height}" class="trend-chart"><text x="${width / 2}" y="${height / 2}" text-anchor="middle">No score data</text></svg>`;
  }

  const minScore = 0.0;
  const maxScore = 1.0;

  const getX = (idx: number) => {
    if (data.length <= 1) return padding.left + chartW / 2;
    return padding.left + (idx / (data.length - 1)) * chartW;
  };

  const getY = (score: number) => {
    const normalized = (score - minScore) / (maxScore - minScore);
    return padding.top + chartH - normalized * chartH;
  };

  // Build grid lines
  let gridLines = "";
  const yTicks = [0, 0.25, 0.5, 0.75, 1.0];
  for (const t of yTicks) {
    const y = getY(t);
    gridLines += `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="var(--border-color, #e2e8f0)" stroke-dasharray="${t === 0 ? "none" : "3,3"}" />`;
    gridLines += `<text x="${padding.left - 10}" y="${y + 4}" text-anchor="end" font-size="11" fill="var(--text-muted, #64748b)">${t.toFixed(2)}</text>`;
  }

  // Find series high
  let maxVal = -1;
  let maxIdx = -1;
  for (const pt of validPoints) {
    if (pt.score !== null && pt.score > maxVal) {
      maxVal = pt.score;
      maxIdx = pt.idx;
    }
  }

  // Build path
  const linePathPoints = validPoints.map((pt) => `${getX(pt.idx)},${getY(pt.score!)}`);
  const linePath = linePathPoints.length > 0 ? `M ${linePathPoints.join(" L ")}` : "";

  // Build points & labels
  let pointsHtml = "";
  for (const d of data) {
    const x = getX(d.idx);
    const labelY = height - padding.bottom + 20;
    pointsHtml += `<text x="${x}" y="${labelY}" text-anchor="middle" font-size="10" fill="var(--text-muted, #64748b)" transform="rotate(-30 ${x} ${labelY})">${d.runId}</text>`;

    if (d.score !== null) {
      const y = getY(d.score);
      const isHigh = d.idx === maxIdx;
      const pointColor = isHigh ? "#10b981" : "#3b82f6";
      const radius = isHigh ? 5 : 4;

      pointsHtml += `
        <g class="chart-point" data-run="${d.runId}" data-score="${d.score.toFixed(4)}" data-date="${d.date}">
          <circle cx="${x}" cy="${y}" r="${radius}" fill="${pointColor}" stroke="#ffffff" stroke-width="2" />
          <text x="${x}" y="${y - 10}" text-anchor="middle" font-size="10" font-weight="${isHigh ? "bold" : "normal"}" fill="${isHigh ? "#059669" : "#1e40af"}">
            ${d.score.toFixed(3)}${isHigh ? " ★" : ""}
          </text>
        </g>`;
    }
  }

  return `
    <svg viewBox="0 0 ${width} ${height}" class="trend-chart" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.2" />
          <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.0" />
        </linearGradient>
      </defs>
      ${gridLines}
      <path d="${linePath}" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
      ${pointsHtml}
    </svg>
  `;
}

/**
 * Builds the HTML content for the dashboard.
 */
export function buildDashboardHtml(runs: QualityRun[]): string {
  // Collect all unique questions across all runs
  const questionsMap = new Map<string, string>();
  for (const r of runs) {
    if (r.cases) {
      for (const c of r.cases) {
        if (c.question && !questionsMap.has(c.question)) {
          questionsMap.set(c.question, c.question);
        }
      }
    }
  }
  const allQuestions = Array.from(questionsMap.keys());

  // Compute summary stats
  const totalRuns = runs.length;
  const latestRun = runs[runs.length - 1];
  let seriesHighRun: QualityRun | null = null;
  let seriesHighScore = -1;

  for (const r of runs) {
    const score = r.aggregates?.meanAll ?? r.aggregates?.meanOperative;
    if (typeof score === "number" && score > seriesHighScore) {
      seriesHighScore = score;
      seriesHighRun = r;
    }
  }

  const latestScore = latestRun?.aggregates?.meanAll ?? latestRun?.aggregates?.meanOperative;

  const trendSvg = generateTrendChartSvg(runs);

  // Embedded JSON payload so client-side diff interactive selector has full data
  const runsJsonString = JSON.stringify(runs).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>do-sift — Quality Run History &amp; Evals Dashboard</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --card-border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --accent-hover: #0284c7;
      --pass: #10b981;
      --pass-bg: rgba(16, 185, 129, 0.15);
      --partial: #f59e0b;
      --partial-bg: rgba(245, 158, 11, 0.15);
      --fail: #ef4444;
      --fail-bg: rgba(239, 68, 68, 0.15);
      --neutral: #64748b;
      --neutral-bg: rgba(100, 116, 139, 0.15);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 24px;
    }
    .container {
      max-width: 1280px;
      margin: 0 auto;
    }
    header {
      margin-bottom: 28px;
      border-bottom: 1px solid var(--card-border);
      padding-bottom: 16px;
    }
    h1 {
      font-size: 26px;
      font-weight: 700;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .badge {
      font-size: 12px;
      padding: 3px 8px;
      border-radius: 9999px;
      background: var(--accent);
      color: #0f172a;
      font-weight: 600;
    }
    .subtitle {
      color: var(--text-muted);
      margin-top: 6px;
      font-size: 14px;
    }
    .grid-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 16px;
    }
    .stat-label {
      color: var(--text-muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .stat-value {
      font-size: 28px;
      font-weight: 700;
      margin-top: 4px;
    }
    .stat-sub {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .section-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 28px;
    }
    .section-title {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .chart-container {
      width: 100%;
      overflow-x: auto;
      background: #090d16;
      border-radius: 6px;
      padding: 12px;
    }
    .trend-chart {
      width: 100%;
      min-width: 700px;
      height: auto;
    }
    /* Heatmap styles */
    .table-container {
      overflow-x: auto;
    }
    table.heatmap {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      text-align: left;
    }
    table.heatmap th, table.heatmap td {
      padding: 8px 10px;
      border: 1px solid var(--card-border);
    }
    table.heatmap th {
      background: #090d16;
      color: var(--text-muted);
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .score-cell {
      text-align: center;
      font-weight: 600;
      border-radius: 4px;
      cursor: pointer;
      transition: transform 0.1s;
    }
    .score-cell:hover {
      transform: scale(1.05);
      outline: 2px solid var(--accent);
    }
    .score-pass { background: var(--pass-bg); color: var(--pass); }
    .score-partial { background: var(--partial-bg); color: var(--partial); }
    .score-fail { background: var(--fail-bg); color: var(--fail); }
    .score-na { background: var(--neutral-bg); color: var(--neutral); }

    /* Diff View styles */
    .diff-controls {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      align-items: center;
      margin-bottom: 20px;
      background: #090d16;
      padding: 14px 18px;
      border-radius: 6px;
    }
    .diff-controls select {
      background: var(--card-bg);
      color: var(--text);
      border: 1px solid var(--card-border);
      padding: 6px 12px;
      border-radius: 4px;
      font-size: 14px;
    }
    .diff-controls label {
      font-size: 13px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .diff-summary-banner {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .diff-metric-pill {
      background: #090d16;
      border: 1px solid var(--card-border);
      padding: 8px 14px;
      border-radius: 6px;
      font-size: 13px;
    }
    .diff-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .diff-table th, .diff-table td {
      padding: 10px 12px;
      border: 1px solid var(--card-border);
    }
    .diff-table th {
      background: #090d16;
      color: var(--text-muted);
    }
    .diff-improved {
      color: var(--pass);
      font-weight: 600;
    }
    .diff-degraded {
      color: var(--fail);
      background: rgba(239, 68, 68, 0.1);
      font-weight: 600;
    }
    .diff-steady {
      color: var(--text-muted);
    }
    .degraded-banner {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid var(--fail);
      padding: 12px 16px;
      border-radius: 6px;
      margin-bottom: 16px;
      font-size: 13px;
    }
    .degraded-banner strong {
      color: #fca5a5;
    }
    /* Notice box */
    .limits-box {
      font-size: 12px;
      color: var(--text-muted);
      border-left: 3px solid var(--accent);
      padding-left: 12px;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>
        do-sift Quality Evals Dashboard
        <span class="badge">Static Report</span>
      </h1>
      <p class="subtitle">Research with receipts: quality gate run history, score trends, per-question heatmaps, and side-by-side run comparisons.</p>
    </header>

    <div class="grid-stats">
      <div class="stat-card">
        <div class="stat-label">Total Evaluated Runs</div>
        <div class="stat-value">${totalRuns}</div>
        <div class="stat-sub">From ${runs[0]?.runId ?? "run-001"} to ${latestRun?.runId ?? "latest"}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Latest Run Score</div>
        <div class="stat-value" style="color: var(--accent);">${typeof latestScore === "number" ? latestScore.toFixed(4) : "N/A"}</div>
        <div class="stat-sub">${latestRun?.runId ?? ""} (${latestRun?.executedAtUtc?.slice(0, 10) ?? ""})</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Series High Score</div>
        <div class="stat-value" style="color: var(--pass);">${seriesHighScore >= 0 ? seriesHighScore.toFixed(4) : "N/A"}</div>
        <div class="stat-sub">${seriesHighRun?.runId ?? ""} (${seriesHighRun?.executedAtUtc?.slice(0, 10) ?? ""})</div>
      </div>
    </div>

    <!-- Trend Visualization -->
    <div class="section-card">
      <div class="section-title">
        <span>Score Trend (Mean Score per Run)</span>
        <span style="font-size: 12px; color: var(--text-muted); font-weight: normal;">Series High: ${seriesHighRun?.runId ?? "run-012"} (${seriesHighScore.toFixed(4)})</span>
      </div>
      <div class="chart-container">
        ${trendSvg}
      </div>
    </div>

    <!-- Heatmap -->
    <div class="section-card">
      <div class="section-title">
        <span>Per-Question Scores Matrix</span>
        <span style="font-size: 12px; color: var(--text-muted); font-weight: normal;">Mean score per case across runs</span>
      </div>
      <div class="table-container">
        <table class="heatmap">
          <thead>
            <tr>
              <th style="min-width: 250px;">Question</th>
              ${runs.map((r) => `<th style="text-align: center; min-width: 45px;">${r.runId}</th>`).join("")}
            </tr>
          </thead>
          <tbody>
            ${allQuestions
              .map((q) => {
                const cells = runs
                  .map((r) => {
                    const c = r.cases?.find((caseItem) => caseItem.question === q);
                    if (!c) {
                      return `<td class="score-cell score-na" title="${r.runId}: Not evaluated">-</td>`;
                    }
                    const score = getCaseScore(c.scores);
                    if (score === null) {
                      return `<td class="score-cell score-na" title="${r.runId}: N/A">N/A</td>`;
                    }
                    let cls = "score-pass";
                    if (score < 0.75 && score >= 0.4) cls = "score-partial";
                    if (score < 0.4) cls = "score-fail";
                    const tooltip = `${r.runId} (${q})&#10;Score: ${score.toFixed(2)}&#10;${DIMENSIONS.map((d) => `${DIMENSION_LABELS[d]}: ${c.scores[d] ?? "N/A"}`).join("&#10;")}`;
                    return `<td class="score-cell ${cls}" title="${tooltip}">${score.toFixed(2)}</td>`;
                  })
                  .join("");
                return `<tr><td style="font-weight: 500;">${q}</td>${cells}</tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Diff Comparison View -->
    <div class="section-card" id="diff-view">
      <div class="section-title">
        <span>Run Comparison &amp; Degradation Diff</span>
      </div>
      <div class="diff-controls">
        <label>
          Baseline Run:
          <select id="diff-baseline-select">
            ${runs.map((r) => `<option value="${r.runId}" ${r.runId === "run-012" ? "selected" : ""}>${r.runId} (${r.executedAtUtc?.slice(0, 10) ?? "unknown"})</option>`).join("")}
          </select>
        </label>
        <span style="color: var(--text-muted);">&rarr;</span>
        <label>
          Comparison Run:
          <select id="diff-target-select">
            ${runs.map((r) => `<option value="${r.runId}" ${r.runId === "run-016" ? "selected" : ""}>${r.runId} (${r.executedAtUtc?.slice(0, 10) ?? "unknown"})</option>`).join("")}
          </select>
        </label>
      </div>

      <div id="diff-output">
        <!-- Rendered dynamically by client script and populated statically for run-012 vs run-016 -->
      </div>
    </div>

    <div class="limits-box">
      <strong>R-06 Limits &amp; Guidance:</strong> Single-annotator authorial labels. These evaluations measure the research, extraction, retrieval, and evidence pipeline under manual and fixture harness protocol (<a href="../../docs/quality-gate.md" style="color: var(--accent);">docs/quality-gate.md</a>), not LLM fluency/reasoning. No quality claim may cite these runs without repeating these limits.
    </div>
  </div>

  <script>
    const RUNS = ${runsJsonString};
    const DIMENSIONS = ${JSON.stringify(DIMENSIONS)};
    const DIMENSION_LABELS = ${JSON.stringify(DIMENSION_LABELS)};

    function renderDiff() {
      const baseId = document.getElementById("diff-baseline-select").value;
      const targetId = document.getElementById("diff-target-select").value;
      const baseRun = RUNS.find(r => r.runId === baseId);
      const targetRun = RUNS.find(r => r.runId === targetId);

      const out = document.getElementById("diff-output");
      if (!baseRun || !targetRun) {
        out.innerHTML = "<p>Select two valid runs to compare.</p>";
        return;
      }

      const baseScore = baseRun.aggregates?.meanAll ?? baseRun.aggregates?.meanOperative ?? "N/A";
      const targetScore = targetRun.aggregates?.meanAll ?? targetRun.aggregates?.meanOperative ?? "N/A";

      // Compare aggregate dimensions
      let aggHtml = '<div class="diff-summary-banner">';
      aggHtml += '<div class="diff-metric-pill"><strong>Overall Mean:</strong> ' + baseScore + ' &rarr; ' + targetScore + '</div>';

      for (const dim of DIMENSIONS) {
        const bVal = baseRun.aggregates?.[dim];
        const tVal = targetRun.aggregates?.[dim];
        let diffCls = "diff-steady";
        if (typeof bVal === "number" && typeof tVal === "number") {
          if (tVal > bVal) diffCls = "diff-improved";
          else if (tVal < bVal) diffCls = "diff-degraded";
        }
        aggHtml += '<div class="diff-metric-pill ' + diffCls + '"><strong>' + DIMENSION_LABELS[dim] + ':</strong> ' +
                   (bVal ?? "N/A") + ' &rarr; ' + (tVal ?? "N/A") + '</div>';
      }
      aggHtml += '</div>';

      // Compare cases & detect degraded questions
      const baseCases = new Map((baseRun.cases || []).map(c => [c.question, c]));
      const targetCases = new Map((targetRun.cases || []).map(c => [c.question, c]));
      const allQs = Array.from(new Set([...baseCases.keys(), ...targetCases.keys()]));

      const degradedQuestions = [];
      const rows = [];

      for (const q of allQs) {
        const bCase = baseCases.get(q);
        const tCase = targetCases.get(q);

        let status = "steady";
        let statusText = "Steady";
        const dimDeltas = [];

        for (const dim of DIMENSIONS) {
          const bScore = bCase?.scores?.[dim];
          const tScore = tCase?.scores?.[dim];
          if (typeof bScore === "number" && typeof tScore === "number") {
            if (tScore < bScore) {
              status = "degraded";
              dimDeltas.push(DIMENSION_LABELS[dim] + " (" + bScore + " &rarr; " + tScore + ")");
            } else if (tScore > bScore && status !== "degraded") {
              status = "improved";
              dimDeltas.push(DIMENSION_LABELS[dim] + " (" + bScore + " &rarr; " + tScore + ")");
            }
          }
        }

        if (status === "degraded") {
          degradedQuestions.push({ question: q, changes: dimDeltas.join(", ") });
          statusText = '<span class="diff-degraded">&darr; Degraded</span>';
        } else if (status === "improved") {
          statusText = '<span class="diff-improved">&uarr; Improved</span>';
        } else {
          statusText = '<span class="diff-steady">&bull; Steady</span>';
        }

        const formatScores = (c) => {
          if (!c) return '<span style="color:var(--text-muted)">Not in run</span>';
          return '<ul style="list-style:none; padding:0; margin:0; font-size:12px;">' +
            DIMENSIONS.map(d => {
              const val = c.scores?.[d];
              return '<li>' + DIMENSION_LABELS[d] + ': <strong>' + (val ?? "N/A") + '</strong></li>';
            }).join("") +
          '</ul>';
        };

        rows.push('<tr>' +
          '<td><strong>' + q + '</strong></td>' +
          '<td>' + statusText + '</td>' +
          '<td>' + formatScores(bCase) + '</td>' +
          '<td>' + formatScores(tCase) + '</td>' +
        '</tr>');
      }

      let degradedNotice = "";
      if (degradedQuestions.length > 0) {
        degradedNotice = '<div class="degraded-banner"><strong>Degraded Questions Detected (' + degradedQuestions.length + '):</strong><ul style="margin-top:6px; margin-left: 20px;">' +
          degradedQuestions.map(d => '<li><strong>' + d.question + '</strong> &mdash; ' + d.changes + '</li>').join("") +
        '</ul></div>';
      } else {
        degradedNotice = '<div class="degraded-banner" style="border-color:var(--pass); background:var(--pass-bg); color:var(--pass);"><strong>No Degraded Questions:</strong> All questions maintained or improved their scores.</div>';
      }

      let tableHtml = '<div class="table-container"><table class="diff-table">' +
        '<thead><tr>' +
          '<th style="width: 30%;">Question</th>' +
          '<th style="width: 15%;">Status</th>' +
          '<th style="width: 27.5%;">' + baseRun.runId + ' Dimension Scores</th>' +
          '<th style="width: 27.5%;">' + targetRun.runId + ' Dimension Scores</th>' +
        '</tr></thead>' +
        '<tbody>' + rows.join("") + '</tbody>' +
      '</table></div>';

      out.innerHTML = aggHtml + degradedNotice + tableHtml;
    }

    document.getElementById("diff-baseline-select").addEventListener("change", renderDiff);
    document.getElementById("diff-target-select").addEventListener("change", renderDiff);
    renderDiff();
  </script>
</body>
</html>`;
}

/**
 * Main dashboard generator entry point.
 */
export function generateDashboard(
  qualityDir = join(process.cwd(), "evals", "quality"),
  outputDir = join(process.cwd(), "evals", "dashboard"),
): { runCount: number; outputPath: string } {
  const runs = loadQualityRuns(qualityDir);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const html = buildDashboardHtml(runs);
  const outputPath = join(outputDir, "index.html");
  writeFileSync(outputPath, html, "utf8");

  return { runCount: runs.length, outputPath };
}

// CLI Execution
if (
  process.argv[1] &&
  (process.argv[1].endsWith("evals-dashboard.ts") || process.argv[1].endsWith("evals-dashboard.js"))
) {
  const res = generateDashboard();
  console.log(`✓ Evals dashboard generated for ${res.runCount} runs at ${res.outputPath}`);
}
