/**
 * Video OS Watcher — UXP Plugin for Premiere Pro
 *
 * Watches a FCP7 XML file for changes and auto-imports into the active project.
 * Designed for the Video OS agent → Premiere Pro roundtrip workflow.
 */

const uxpFs = require("uxp").storage.localFileSystem;

// ── State ──────────────────────────────────────────────────────────

let watchTimer = null;
let lastMtime = 0;
let watchEntry = null; // UXP file entry (from picker)
let watchPath = "";

// ── DOM refs ───────────────────────────────────────────────────────

const elXmlPath = document.getElementById("xmlPath");
const elInterval = document.getElementById("interval");
const btnBrowse = document.getElementById("btnBrowse");
const btnStart = document.getElementById("btnStart");
const btnStop = document.getElementById("btnStop");
const elStatus = document.getElementById("status");

// ── Status display ─────────────────────────────────────────────────

function setStatus(dotClass, message) {
  const ts = new Date().toLocaleTimeString();
  elStatus.innerHTML =
    '<span class="dot ' + dotClass + '"></span>' + ts + " " + message;
}

function appendLog(message) {
  const ts = new Date().toLocaleTimeString();
  elStatus.innerHTML += "\n" + ts + " " + message;
  elStatus.scrollTop = elStatus.scrollHeight;
}

// ── File picker ────────────────────────────────────────────────────

async function browseFile() {
  try {
    const entry = await uxpFs.getFileForOpening({
      types: ["xml"],
      allowMultiple: false,
    });
    if (entry) {
      watchEntry = entry;
      watchPath = entry.nativePath;
      elXmlPath.value = watchPath;
      setStatus("dot-idle", "File selected: " + entry.name);
    }
  } catch (err) {
    setStatus("dot-error", "Browse error: " + (err.message || err));
  }
}

// ── File stat helper ───────────────────────────────────────────────

async function getFileMtime() {
  try {
    if (!watchEntry) return 0;
    const meta = await watchEntry.getMetadata();
    return meta.modificationDate ? meta.modificationDate.getTime() : 0;
  } catch {
    return 0;
  }
}

// ── Import sequence into Premiere Pro ──────────────────────────────

async function importXmlSequence() {
  try {
    const app = require("premierepro");
    const project = await app.Project.getActiveProject();
    if (!project) {
      appendLog("[ERROR] No active project");
      return false;
    }

    // Import the XML file — Premiere treats FCP7 XML as importable media
    const success = await project.importFiles(
      [watchPath],
      true,  // suppressUI
      project.getRootItem(), // target bin
      false  // importAsNumberedStills
    );

    if (success) {
      appendLog("[OK] Imported sequence from XML");
      return true;
    } else {
      appendLog("[WARN] importFiles returned false");
      return false;
    }
  } catch (err) {
    appendLog("[ERROR] Import failed: " + (err.message || err));
    return false;
  }
}

// ── Poll loop ──────────────────────────────────────────────────────

async function pollOnce() {
  try {
    const currentMtime = await getFileMtime();

    if (currentMtime === 0) {
      setStatus("dot-error", "Cannot read file");
      return;
    }

    if (lastMtime === 0) {
      // First poll — just record the mtime
      lastMtime = currentMtime;
      setStatus("dot-watching", "Watching: " + (watchEntry ? watchEntry.name : watchPath));
      return;
    }

    if (currentMtime > lastMtime) {
      lastMtime = currentMtime;
      setStatus("dot-updated", "Change detected, importing...");
      const ok = await importXmlSequence();
      if (ok) {
        setStatus("dot-watching", "Import complete. Watching...");
      } else {
        setStatus("dot-error", "Import failed. Still watching...");
      }
    }
  } catch (err) {
    setStatus("dot-error", "Poll error: " + (err.message || err));
  }
}

// ── Start / Stop ───────────────────────────────────────────────────

function startWatch() {
  if (!watchEntry) {
    setStatus("dot-error", "Please select an XML file first (Browse)");
    return;
  }

  const intervalMs = parseInt(elInterval.value, 10) || 2000;
  lastMtime = 0;

  setStatus("dot-watching", "Starting watch...");
  btnStart.disabled = true;
  btnStop.disabled = false;
  btnBrowse.disabled = true;
  elInterval.disabled = true;

  // Initial poll
  pollOnce();
  watchTimer = setInterval(pollOnce, intervalMs);
}

function stopWatch() {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
  lastMtime = 0;

  setStatus("dot-idle", "Stopped");
  btnStart.disabled = false;
  btnStop.disabled = true;
  btnBrowse.disabled = false;
  elInterval.disabled = false;
}

// ── Event listeners ────────────────────────────────────────────────

btnBrowse.addEventListener("click", browseFile);
btnStart.addEventListener("click", startWatch);
btnStop.addEventListener("click", stopWatch);
