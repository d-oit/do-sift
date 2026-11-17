/**
 * Stateless report export (issue #170, FUP-02).
 *
 * Formats an explicitly supplied `ResearchReport` with the pure formatters in
 * `@do-sift/contracts`, or, when the host provides `reportFor`, assembles one
 * from a stored answer (`answerId`) or collection (`collectionId`). The
 * stateless mode stores nothing and reads no corpus rows. Stored modes read
 * only rows the authenticated owner already has; neither mode calls a model
 * or adds evidence. The question and annotations remain private unless the
 * request opts in, as with the CLI exporter.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_TENANT_ID, roleAllows } from "@do-sift/contracts";
import {
  REPORT_SCHEMA_VERSION,
  toBibTeX,
  toHtmlReport,
  toJsonReport,
  toMarkdownReport,
  type ResearchReport,
  type ReportAnnotation,
  type ReportClaim,
  type ReportSource,
} from "@do-sift/contracts";
import type { AuthenticatedRequestOwner, ResearchServerOptions } from "./server-contracts.js";
import {
  HttpRequestError,
  assertJsonContentType,
  jsonError,
  readBody,
  respondAuthFailure,
} from "./server-http.js";

export const REPORT_EXPORT_PATH = "/api/reports/export";

const FORMATS = ["json", "markdown", "html", "bibtex"] as const;
type Format = (typeof FORMATS)[number];

const LIMITS = {
  question: 2_000,
  sources: 100,
  claims: 100,
  annotations: 100,
  text: 8_000,
  url: 2_048,
  id: 128,
  citations: 50,
} as const;

function isFormat(value: unknown): value is Format {
  return typeof value === "string" && (FORMATS as readonly string[]).includes(value);
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") throw new HttpRequestError(400, `${name} must be a string`);
  if (value.length > max) throw new HttpRequestError(400, `${name} is too long`);
  return value;
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  return value === undefined ? undefined : text(value, name, max);
}

function parseSource(raw: unknown, index: number): ReportSource {
  const value = raw as Record<string, unknown>;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpRequestError(400, `sources[${index}] must be an object`);
  }
  const source: ReportSource = {
    id: text(value["id"], `sources[${index}].id`, LIMITS.id),
    url: text(value["url"], `sources[${index}].url`, LIMITS.url),
    fetchedAt: text(value["fetchedAt"], `sources[${index}].fetchedAt`, LIMITS.id),
  };
  const title = optionalText(value["title"], `sources[${index}].title`, LIMITS.text);
  const publisher = optionalText(value["publisher"], `sources[${index}].publisher`, LIMITS.text);
  const publishedAt = optionalText(
    value["publishedAt"],
    `sources[${index}].publishedAt`,
    LIMITS.id,
  );
  const contentHash = optionalText(
    value["contentHash"],
    `sources[${index}].contentHash`,
    LIMITS.id,
  );
  if (title !== undefined) source.title = title;
  if (publisher !== undefined) source.publisher = publisher;
  if (publishedAt !== undefined) source.publishedAt = publishedAt;
  if (contentHash !== undefined) source.contentHash = contentHash;
  return source;
}

function parseClaim(raw: unknown, index: number): ReportClaim {
  const value = raw as Record<string, unknown>;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpRequestError(400, `claims[${index}] must be an object`);
  }
  const kind = value["kind"];
  if (kind !== "paragraph" && kind !== "list" && kind !== "caveat") {
    throw new HttpRequestError(400, `claims[${index}].kind is invalid`);
  }
  const rawCitations = value["citations"];
  if (!Array.isArray(rawCitations) || rawCitations.length > LIMITS.citations) {
    throw new HttpRequestError(400, `claims[${index}].citations must be a bounded array`);
  }
  const citations = rawCitations.map((citation, position) =>
    text(citation, `claims[${index}].citations[${position}]`, LIMITS.id),
  );
  const claim: ReportClaim = {
    kind,
    text: text(value["text"], `claims[${index}].text`, LIMITS.text),
    citations,
  };
  if (value["unresolved"] === true) claim.unresolved = true;
  return claim;
}

function parseAnnotation(raw: unknown, index: number): ReportAnnotation {
  const value = raw as Record<string, unknown>;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpRequestError(400, `annotations[${index}] must be an object`);
  }
  return {
    id: text(value["id"], `annotations[${index}].id`, LIMITS.id),
    body: text(value["body"], `annotations[${index}].body`, LIMITS.text),
    createdAt: text(value["createdAt"], `annotations[${index}].createdAt`, LIMITS.id),
  };
}

function parseReport(raw: unknown): ResearchReport {
  const value = raw as Record<string, unknown>;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpRequestError(400, "report must be an object");
  }
  if (value["schemaVersion"] !== REPORT_SCHEMA_VERSION) {
    throw new HttpRequestError(400, `report.schemaVersion must be ${REPORT_SCHEMA_VERSION}`);
  }
  const rawSources = value["sources"];
  const rawClaims = value["claims"];
  const rawAnnotations = value["annotations"];
  if (!Array.isArray(rawSources) || rawSources.length > LIMITS.sources) {
    throw new HttpRequestError(400, "report.sources must be a bounded array");
  }
  if (!Array.isArray(rawClaims) || rawClaims.length > LIMITS.claims) {
    throw new HttpRequestError(400, "report.claims must be a bounded array");
  }
  if (!Array.isArray(rawAnnotations) || rawAnnotations.length > LIMITS.annotations) {
    throw new HttpRequestError(400, "report.annotations must be a bounded array");
  }
  const report: ResearchReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    sources: rawSources.map(parseSource),
    claims: rawClaims.map(parseClaim),
    annotations: rawAnnotations.map(parseAnnotation),
  };
  const question = optionalText(value["question"], "report.question", LIMITS.question);
  if (question !== undefined) report.question = question;
  return report;
}

function render(
  report: ResearchReport,
  format: Format,
  options: {
    includeQuestion: boolean;
    includeAnnotations: boolean;
  },
): { body: string; contentType: string; extension: string } {
  switch (format) {
    case "json":
      return {
        body: toJsonReport(report, options),
        contentType: "application/json; charset=utf-8",
        extension: "json",
      };
    case "markdown":
      return {
        body: toMarkdownReport(report, options),
        contentType: "text/markdown; charset=utf-8",
        extension: "md",
      };
    case "html":
      return {
        body: toHtmlReport(report, options),
        contentType: "text/html; charset=utf-8",
        extension: "html",
      };
    case "bibtex":
      return {
        body: toBibTeX(report),
        contentType: "application/x-bibtex; charset=utf-8",
        extension: "bib",
      };
  }
}

export async function handleReportExport(
  req: IncomingMessage,
  res: ServerResponse,
  options: ResearchServerOptions,
  httpRequestId: string,
  maxBodyBytes: number,
): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    jsonError(res, 405, "method not allowed", httpRequestId, req);
    return;
  }

  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  let owner: AuthenticatedRequestOwner;
  try {
    owner = await options.auth.authenticateOwner({
      token,
      clientAddress: req.socket.remoteAddress ?? "",
    });
  } catch (error) {
    respondAuthFailure(res, error, httpRequestId, req);
    return;
  }

  const principal = {
    tenantId: owner.tenantId ?? DEFAULT_TENANT_ID,
    userId: owner.ownerId,
  };
  if (options.roleFor !== undefined) {
    const role = await options.roleFor(principal);
    if (!roleAllows(role, "read")) {
      jsonError(res, 403, "forbidden", httpRequestId, req);
      return;
    }
  }

  try {
    assertJsonContentType(req);
    let raw: unknown;
    try {
      raw = JSON.parse(await readBody(req, maxBodyBytes)) as unknown;
    } catch (error) {
      if (error instanceof HttpRequestError) throw error;
      throw new HttpRequestError(400, "request body must be valid JSON");
    }
    const body = raw as Record<string, unknown>;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new HttpRequestError(400, "request body must be a JSON object");
    }
    if (!isFormat(body["format"])) {
      throw new HttpRequestError(400, `format must be one of: ${FORMATS.join(", ")}`);
    }
    const answerId = optionalText(body["answerId"], "answerId", LIMITS.id);
    const collectionId = optionalText(body["collectionId"], "collectionId", LIMITS.id);
    const modes = [
      body["report"] !== undefined,
      answerId !== undefined,
      collectionId !== undefined,
    ].filter(Boolean).length;
    if (modes !== 1) {
      throw new HttpRequestError(
        400,
        "exactly one of report, answerId, or collectionId is required",
      );
    }
    let report: ResearchReport;
    if (body["report"] !== undefined) {
      report = parseReport(body["report"]);
    } else {
      if (options.reportFor === undefined) {
        throw new HttpRequestError(501, "stored report export is not configured");
      }
      const handlers = await options.reportFor(principal);
      const stored =
        answerId !== undefined
          ? await handlers.fromAnswer(owner.ownerId, answerId)
          : await handlers.fromCollection(owner.ownerId, collectionId ?? "");
      if (stored === undefined) throw new HttpRequestError(404, "report source not found");
      report = stored;
    }
    const rendered = render(report, body["format"], {
      includeQuestion: body["includeQuestion"] === true,
      includeAnnotations: body["includeAnnotations"] === true,
    });
    res.writeHead(200, {
      "content-type": rendered.contentType,
      "content-disposition": `attachment; filename="report.${rendered.extension}"`,
      "cache-control": "no-store",
      "x-request-id": httpRequestId,
    });
    res.end(rendered.body);
  } catch (error) {
    if (error instanceof HttpRequestError) {
      jsonError(res, error.status, error.message, httpRequestId, req);
      return;
    }
    console.error(`[${httpRequestId}] report export failed: ${String(error)}`);
    jsonError(res, 500, "internal error", httpRequestId, req);
  }
}
