/**
 * Video OS Watcher — UXP Plugin for Premiere Pro
 *
 * Watches a FCP7 XML file for changes and auto-imports into the active project.
 * Designed for the Video OS agent → Premiere Pro roundtrip workflow.
 */

/* global require */
const fs = require("uxp").storage.localFileSystem;

// ── State ──────────────────────────────────────────────────────────

let watchTimer = null;
let lastMtime = 0;
let watchPath = "";

// ── DOM refs ───────────────────────────────────────────────────────

const elXmlPath = document.getElementById("xmlPath");
const elInterval = document.getElementById("interval");
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

// ── File stat helper ───────────────────────────────────────────────

async function getFileMtime(filePath) {
  try {
    // UXP fs: get entry from path, then read metadata
    const entry = await fs.getEntryWithUrl("file:" + filePath);
    if (!entry) return 0;
    const meta = await entry.getMetadata();
    return meta.modificationDate ? meta.modificationDate.getTime() : 0;
  } catch {
    // Fallback: try native fs module if available
    try {
      const nfs = require("fs");
      const stat = nfs.lstatSync(filePath);
      return stat.mtimeMs || 0;
    } catch {
      return 0;
    }
  }
}

// ── Import sequence into Premiere Pro ──────────────────────────────

async function importXmlSequence(filePath) {
  try {
    const app = require("premierepro");
    const project = await app.Project.getActiveProject();
    if (!project) {
      appendLog("[ERROR] No active project");
      return false;
    }

    // Import the XML file — Premiere treats FCP7 XML as importable media
    const success = await project.importFiles(
      [filePath],
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
    const currentMtime = await getFileMtime(watchPath);

    if (currentMtime === 0) {
      setStatus("dot-error", "File not found: " + watchPath);
      return;
    }

    if (lastMtime === 0) {
      // First poll — just record the mtime
      lastMtime = currentMtime;
      setStatus("dot-watching", "Watching: " + watchPath.split("/").pop());
      return;
    }

    if (currentMtime > lastMtime) {
      lastMtime = currentMtime;
      setStatus("dot-updated", "Change detected, importing...");
      const ok = await importXmlSequence(watchPath);
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
  const xmlPath = elXmlPath.value.trim();
  if (!xmlPath) {
    setStatus("dot-error", "Please enter an XML file path");
    return;
  }

  const intervalMs = parseInt(elInterval.value, 10) || 2000;
  watchPath = xmlPath;
  lastMtime = 0;

  setStatus("dot-watching", "Starting watch...");
  btnStart.disabled = true;
  btnStop.disabled = false;
  elXmlPath.disabled = true;
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
  watchPath = "";

  setStatus("dot-idle", "Stopped");
  btnStart.disabled = false;
  btnStop.disabled = true;
  elXmlPath.disabled = false;
  elInterval.disabled = false;
}

// ── Event listeners ────────────────────────────────────────────────

btnStart.addEventListener("click", startWatch);
btnStop.addEventListener("click", stopWatch);
