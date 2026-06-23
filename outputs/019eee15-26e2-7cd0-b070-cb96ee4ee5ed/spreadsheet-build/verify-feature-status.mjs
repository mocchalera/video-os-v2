import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const outputDir = "/Users/mocchalera/Dev/video-os-v2-spec/outputs/019eee15-26e2-7cd0-b070-cb96ee4ee5ed";
const workbookPath = path.join(outputDir, "video-os-v2-feature-status.xlsx");
const inspectPath = path.join(outputDir, "video-os-v2-feature-status.xlsx.inspect.ndjson");
const renderDir = path.join(outputDir, "spreadsheet-build", "renders");

await fs.mkdir(renderDir, { recursive: true });

const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseNDJSON(text) {
  return text
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function readInspectTables() {
  const [workbookStats, inspectStats, inspectText] = await Promise.all([
    fs.stat(workbookPath),
    fs.stat(inspectPath),
    fs.readFile(inspectPath, "utf8"),
  ]);
  assert(
    inspectStats.mtimeMs >= workbookStats.mtimeMs - 1000,
    `Inspect NDJSON is older than workbook: ${inspectPath}`,
  );
  const tables = new Map();
  for (const item of parseNDJSON(inspectText)) {
    if (item.kind === "table" && item.sheet && Array.isArray(item.values)) {
      tables.set(item.sheet, item.values);
    }
  }
  return tables;
}

function tableRows(tables, sheetName) {
  const table = tables.get(sheetName);
  assert(table, `Missing table for sheet ${sheetName}`);
  const [headers, ...rows] = table;
  return rows.map((row, index) => ({
    rowNumber: index + 2,
    ...Object.fromEntries(headers.map((header, column) => [String(header), row[column]])),
  }));
}

function verifyTrackerSemantics(tables) {
  const summary = tableRows(tables, "Summary");
  const stories = tableRows(tables, "Stories");
  const issues = tableRows(tables, "Issues");
  const testLog = tableRows(tables, "Test Log");
  const openGates = tableRows(tables, "Open Gates");
  const completionAudit = tableRows(tables, "Completion Audit");

  const summaryValue = (metric) => summary.find((row) => row.Metric === metric)?.Value;
  assert(summaryValue("Stories tracked") === stories.length, "Summary Stories tracked does not match Stories rows");
  assert(summaryValue("Issues tracked") === issues.length, "Summary Issues tracked does not match Issues rows");

  const unresolvedIssues = issues.filter((row) => !String(row.Status ?? "").startsWith("Fixed"));
  assert(
    unresolvedIssues.length === 1 && unresolvedIssues[0]["Issue ID"] === "ISS-050",
    `Expected only ISS-050 unresolved; got ${unresolvedIssues
      .map((row) => `${row["Issue ID"]}:${row.Status}`)
      .join(", ")}`,
  );
  assert(
    String(unresolvedIssues[0].Status).includes("repo preference gate pending"),
    "ISS-050 status must keep the repo preference gate caveat",
  );

  assert(openGates.length === 1, `Expected one open gate, got ${openGates.length}`);
  assert(openGates[0]["Gate ID"] === "GATE-001", "Open gate must be GATE-001");
  assert(openGates[0].Related === "ISS-050 / US-061", "GATE-001 must point to ISS-050 / US-061");
  assert(openGates[0].Status === "Open external dependency", "GATE-001 must remain an open external dependency");
  assert(
    String(openGates[0]["Current Evidence"]).includes("TL-265")
      && String(openGates[0]["Current Evidence"]).includes("matched=0")
      && String(openGates[0]["Current Evidence"]).includes("unmatched=9"),
    "GATE-001 evidence must include the latest TL-265 relink recheck",
  );

  const auditByID = new Map(completionAudit.map((row) => [row["Requirement ID"], row]));
  assert(auditByID.get("REQ-007")?.["Current Verdict"] === "Not complete", "REQ-007 must remain Not complete");
  assert(
    String(auditByID.get("REQ-004")?.["Current Verdict"]).includes("one external gate remains"),
    "REQ-004 must describe the remaining external gate",
  );
  assert(
    String(auditByID.get("REQ-005")?.Evidence).includes("ISS-050 remains non-Fixed"),
    "REQ-005 must identify ISS-050 as the only non-Fixed issue",
  );

  assert(testLog.length === 266, `Expected 266 Test Log rows, got ${testLog.length}`);
  const latestLog = testLog.find((row) => row["Log ID"] === "TL-265");
  assert(latestLog, "Missing TL-265 test log entry");
  assert(
    String(latestLog.Result).includes("GATE-001 unchanged"),
    "TL-265 result must preserve the current external-gate outcome",
  );
  const semanticVerifierLog = testLog.find((row) => row["Log ID"] === "TL-266");
  assert(semanticVerifierLog, "Missing TL-266 semantic verifier test log entry");
  assert(
    String(semanticVerifierLog.Result).includes("semantic verification pass"),
    "TL-266 result must record the tracker semantic verifier pass",
  );

  const storyByID = new Map(stories.map((row) => [row["Story ID"], row]));
  assert(
    String(storyByID.get("US-060")?.["Current Status"]).includes("acceptance smoke CLI hang fixed"),
    "US-060 status must mention the acceptance smoke CLI hang fix",
  );
  assert(
    String(storyByID.get("US-061")?.["Current Status"]).includes("repo preference gate pending"),
    "US-061 status must preserve the repo preference gate caveat",
  );
}

const sheets = await workbook.inspect({
  kind: "sheet",
  include: "name",
  summary: "sheet list",
});
console.log("SHEETS");
console.log(sheets.ndjson);
const sheetItems = parseNDJSON(sheets.ndjson).filter((item) => item.kind === "sheet");
assert(sheetItems.length === 7, `Expected 7 sheets, got ${sheetItems.length}`);

const macEntries = await workbook.inspect({
  kind: "match",
  searchTerm: "US-045|US-046|US-047|US-048|US-049|US-050|US-051|US-052|US-053|US-054|US-055|US-056|US-057|US-058|US-059|US-060|US-061|US-062|US-063|US-064|US-065|US-066|ISS-024|ISS-025|ISS-026|ISS-027|ISS-028|ISS-029|ISS-030|ISS-031|ISS-032|ISS-033|ISS-034|ISS-035|ISS-036|ISS-037|ISS-038|ISS-039|ISS-040|ISS-041|ISS-042|ISS-043|ISS-044|ISS-045|ISS-046|ISS-047|ISS-048|ISS-049|ISS-050|ISS-051|ISS-052|ISS-053|ISS-054|ISS-055|ISS-056|ISS-057|ISS-058|ISS-059|TL-056|TL-059|TL-060|TL-061|TL-062|TL-063|TL-064|TL-065|TL-066|TL-067|TL-068|TL-069|TL-070|TL-071|TL-072|TL-073|TL-074|TL-075|TL-076|TL-077|TL-078|TL-079|TL-080|TL-081|TL-082|TL-083|TL-084|TL-085|TL-086|TL-087|TL-088|TL-089|TL-090|TL-091|TL-092|TL-093|TL-094|TL-095|TL-096|TL-097|TL-098|TL-099|TL-100|TL-101|TL-102|TL-103|TL-104|TL-105|TL-106|TL-107|TL-108|TL-109|TL-110|TL-111|TL-112|TL-113|TL-114|TL-115|TL-116|TL-117|TL-118|TL-119|TL-120|TL-121|TL-122|TL-123|TL-124|TL-125|TL-126|TL-127|TL-128|TL-129|TL-130|TL-131|TL-132|TL-133|TL-134|TL-135|TL-136|TL-137|TL-138|TL-139|TL-140|TL-141|TL-142|TL-143|TL-144|TL-145|TL-146|TL-147|TL-148|TL-149|TL-150|TL-151|TL-152|TL-153|TL-154|TL-155|TL-156|TL-157|TL-158|TL-159|TL-160|TL-161|TL-162|TL-163|TL-164|TL-165|TL-166|TL-167|TL-168|TL-169|TL-170|TL-171|TL-172|TL-173|TL-174|TL-175|TL-176|TL-177|TL-178|TL-179|TL-180|TL-181|TL-182|TL-183|TL-184|TL-185|TL-186|TL-187|TL-188|TL-189|TL-190|TL-191|TL-192|TL-193|TL-194|TL-195|TL-196|TL-197|TL-198|TL-199|TL-200|TL-201|TL-202|TL-203|MediaPanel\\.IndexSearchField|MediaPanel\\.AddRAGContextButton|MediaPanel\\.RunMarlinEvaluationButton|MediaPanel\\.ApplyMarlinPreferenceButton|MediaPanel\\.MarlinEvaluationCommandLine|ClipInspector\\.NoteDraftEditor|ClipInspector\\.SaveNoteButton|QADashboard\\.BriefAlignmentRadar|QADashboard\\.IssueJumpButton",
  options: { useRegex: true, maxResults: 500 },
  summary: "macOS project initialization, Agent menu availability, Viewer layer, Viewer timeline-preview priority, Viewer poster-frame tracker, Clip Inspector UI identifier tracker, QA Dashboard UI identifier tracker, Audio Story native tracker, Render button tracker, Editor Handoff tracker, SQLite/RAG UI identifier tracker, Marlin timeout/identifier tracker, and main-window placement tracker additions",
});
console.log("MAC ENTRIES");
console.log(macEntries.ndjson);

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 300 },
  summary: "formula error scan",
});
console.log("FORMULA ERRORS");
console.log(errors.ndjson);
const formulaErrorItems = parseNDJSON(errors.ndjson).filter((item) => item.kind === "match");
assert(formulaErrorItems.length === 0, `Formula errors found: ${formulaErrorItems.length}`);

const inspectTables = await readInspectTables();
verifyTrackerSemantics(inspectTables);
console.log("TRACKER SEMANTICS OK");

for (const sheetName of ["Summary", "Stories", "Issues", "Test Log", "Open Gates", "Completion Audit", "Code Map"]) {
  const blob = await workbook.render({
    sheetName,
    autoCrop: "all",
    scale: 1,
    format: "png",
  });
  const filename = `${sheetName.toLowerCase().replaceAll(" ", "-")}.png`;
  const renderPath = path.join(renderDir, filename);
  await fs.writeFile(renderPath, new Uint8Array(await blob.arrayBuffer()));
  console.log(`RENDER ${sheetName} ${renderPath}`);
}
