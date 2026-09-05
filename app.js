// ---------- Local-first storage (IndexedDB) ----------
// No account, no network required. Everything lives in this browser.
const DB_NAME = "notes-app-db";
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("folders")) db.createObjectStore("folders", { keyPath: "id" });
      if (!db.objectStoreNames.contains("entries")) db.createObjectStore("entries", { keyPath: "id" });
      if (!db.objectStoreNames.contains("pages")) db.createObjectStore("pages", { keyPath: "id" });
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbGetAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function newId() {
  return crypto.randomUUID();
}

async function getPagesForEntry(entryId) {
  const all = await idbGetAll("pages");
  return all.filter((p) => p.entry_id === entryId).sort((a, b) => a.position - b.position);
}

// ---------- DOM references ----------
const sidebarToggleBtn = document.getElementById("sidebar-toggle-btn");
const sidebarEl = document.getElementById("sidebar");
const sidebarBackdropEl = document.getElementById("sidebar-backdrop");
const journalNameInput = document.getElementById("journal-name");
const treeEl = document.getElementById("tree");
const newFolderBtn = document.getElementById("new-folder-btn");
const newFileBtn = document.getElementById("new-file-btn");

const titleInput = document.getElementById("entry-title");
const editorInput = document.getElementById("entry-editor");
const pageWrapEl = document.getElementById("page-wrap");
const zoomOuterEl = document.getElementById("zoom-outer");
const canvasEl = document.getElementById("canvas");
const pageEl = document.getElementById("page");
const pageTabsEl = document.getElementById("page-tabs");
const emptyState = document.getElementById("empty-state");
const saveStatus = document.getElementById("save-status");
const deleteEntryBtn = document.getElementById("delete-entry-btn");
const fontSizeSelect = document.getElementById("font-size-select");
const noteTypeSelect = document.getElementById("note-type-select");
const themeSelect = document.getElementById("theme-select");
const installBtn = document.getElementById("install-btn");
const markdownPreviewBtn = document.getElementById("markdown-preview-btn");
const markdownPreviewEl = document.getElementById("markdown-preview");
const zoomInBtn = document.getElementById("zoom-in-btn");
const zoomOutBtn = document.getElementById("zoom-out-btn");
const zoomResetBtn = document.getElementById("zoom-reset-btn");
const zoomLevelEl = document.getElementById("zoom-level");

const NOTE_TYPE_LABELS = {
  plain: "Plain",
  markdown: "Markdown",
  scriptwriter: "Script",
  author: "Book",
  diary: "Diary",
  postit: "Post-it",
};

const measureMirror = document.createElement("div");
measureMirror.style.position = "absolute";
measureMirror.style.visibility = "hidden";
measureMirror.style.top = "-9999px";
measureMirror.style.left = "-9999px";
measureMirror.style.whiteSpace = "pre-wrap";
measureMirror.style.wordWrap = "break-word";
measureMirror.style.overflowWrap = "break-word";
document.body.appendChild(measureMirror);

// ---------- State ----------
let folders = [];
let entries = [];
let openFolderIds = new Set();
let currentEntryId = null;
let pages = [];
let currentPageId = null;
let saveTimer = null;
let journalNameSaveTimer = null;
let dirtyPageIds = new Set();
let titleDirty = false;
let suppressReflow = false;

// ---------- Sidebar drawer ----------
function openSidebar() {
  sidebarEl.classList.add("open");
  sidebarBackdropEl.classList.remove("hidden");
}
function closeSidebar() {
  sidebarEl.classList.remove("open");
  sidebarBackdropEl.classList.add("hidden");
}
sidebarToggleBtn.addEventListener("click", () => {
  if (sidebarEl.classList.contains("open")) closeSidebar();
  else openSidebar();
});
sidebarBackdropEl.addEventListener("click", closeSidebar);

// ---------- Journal name ----------
async function loadJournalName() {
  const rec = await idbGet("settings", "journal_name");
  if (rec) {
    journalNameInput.value = rec.value;
  } else {
    journalNameInput.value = "My notes";
    await idbPut("settings", { key: "journal_name", value: "My notes" });
  }
}

journalNameInput.addEventListener("input", () => {
  clearTimeout(journalNameSaveTimer);
  journalNameSaveTimer = setTimeout(saveJournalName, 400);
});
journalNameInput.addEventListener("blur", () => {
  clearTimeout(journalNameSaveTimer);
  saveJournalName();
});
async function saveJournalName() {
  const name = journalNameInput.value.trim() || "My notes";
  await idbPut("settings", { key: "journal_name", value: name });
}

// ---------- Data loading ----------
async function loadData() {
  folders = await idbGetAll("folders");
  entries = await idbGetAll("entries");
  renderTree();
}

async function openStartingEntry() {
  const untitledCandidates = entries.filter((e) => !e.title);

  for (const candidate of untitledCandidates) {
    const candidatePages = await getPagesForEntry(candidate.id);
    const isEmpty = candidatePages.every((p) => !p.content || !p.content.trim());
    if (isEmpty && candidatePages.length) {
      await openEntry(candidate.id, candidatePages);
      return;
    }
  }

  await createAndOpenNewEntry();
}

// ---------- Tree rendering ----------
function renderTree() {
  treeEl.innerHTML = "";
  const rootFolders = folders.filter((f) => !f.parent_id);
  const rootEntries = entries.filter((e) => !e.folder_id);
  renderFolderList(rootFolders, treeEl, 0);
  renderEntryList(rootEntries, treeEl, 0);
}

function renderFolderList(folderList, container, depth) {
  folderList.forEach((folder) => {
    const isOpen = openFolderIds.has(folder.id);
    const row = document.createElement("div");
    row.className = "tree-row";
    row.style.paddingLeft = `${depth * 14 + 6}px`;
    row.innerHTML = `
      <span class="chevron">${isOpen ? "▾" : "▸"}</span>
      <span class="row-icon">🗀</span>
      <span class="row-label">${escapeHtml(folder.name)}</span>
      <span class="row-delete" title="Delete folder">✕</span>
    `;
    row.querySelector(".row-label").addEventListener("click", () => toggleFolder(folder.id));
    row.querySelector(".chevron").addEventListener("click", () => toggleFolder(folder.id));
    row.querySelector(".row-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteFolder(folder.id);
    });
    container.appendChild(row);

    if (isOpen) {
      const childFolders = folders.filter((f) => f.parent_id === folder.id);
      const childEntries = entries.filter((e) => e.folder_id === folder.id);
      renderFolderList(childFolders, container, depth + 1);
      renderEntryList(childEntries, container, depth + 1);
    }
  });
}

function renderEntryList(entryList, container, depth) {
  entryList.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "tree-row" + (entry.id === currentEntryId ? " selected" : "");
    row.style.paddingLeft = `${depth * 14 + 20}px`;
    const label = entry.title
      ? escapeHtml(entry.title)
      : '<span class="row-label-empty">(untitled)</span>';
    row.innerHTML = `
      <span class="row-icon">▤</span>
      <span class="row-label">${label}</span>
      <span class="row-delete" title="Delete entry">✕</span>
    `;
    row.querySelector(".row-label").addEventListener("click", async () => {
      await openEntry(entry.id);
      closeSidebar();
    });
    row.querySelector(".row-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteEntry(entry.id);
    });
    container.appendChild(row);
  });
}

function toggleFolder(id) {
  if (openFolderIds.has(id)) openFolderIds.delete(id);
  else openFolderIds.add(id);
  renderTree();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Creating folders / entries ----------
newFolderBtn.addEventListener("click", async () => {
  const name = prompt("Folder name:");
  if (!name) return;
  const folder = { id: newId(), name, parent_id: null, created_at: Date.now() };
  await idbPut("folders", folder);
  folders.push(folder);
  renderTree();
});

newFileBtn.addEventListener("click", async () => {
  await createAndOpenNewEntry();
  closeSidebar();
});

async function createAndOpenNewEntry() {
  const entry = { id: newId(), title: "", folder_id: null, created_at: Date.now() };
  await idbPut("entries", entry);

  const page = {
    id: newId(),
    entry_id: entry.id,
    note_type: "plain",
    theme: "classic",
    font_size: 15,
    content: "",
    position: 0,
  };
  await idbPut("pages", page);

  entries.push(entry);
  renderTree();
  await openEntry(entry.id, [page]);
}

// ---------- Deleting ----------
async function deleteFolder(id) {
  if (!confirm("Delete this folder and everything inside it?")) return;
  await idbDelete("folders", id);
  folders = folders.filter((f) => f.id !== id);
  entries = entries.filter((e) => e.folder_id !== id);
  renderTree();
}

async function deleteEntry(id) {
  if (!confirm("Delete this entry and all its pages?")) return;
  const entryPages = await getPagesForEntry(id);
  await Promise.all(entryPages.map((p) => idbDelete("pages", p.id)));
  await idbDelete("entries", id);

  entries = entries.filter((e) => e.id !== id);
  if (currentEntryId === id) {
    currentEntryId = null;
    currentPageId = null;
    pages = [];
    await openStartingEntry();
    return;
  }
  renderTree();
}

deleteEntryBtn.addEventListener("click", () => {
  if (currentEntryId) deleteEntry(currentEntryId);
});

// ---------- Opening entries & their pages ----------
async function openEntry(id, preloadedPages) {
  await flushSave();

  const entry = entries.find((e) => e.id === id);
  if (!entry) return;

  currentEntryId = id;
  titleInput.value = entry.title || "";

  pages = preloadedPages || (await getPagesForEntry(id));
  currentPageId = pages[0] ? pages[0].id : null;

  renderPageTabs();
  loadPageIntoEditor(currentPageId);
  showEditor();
  fitToWidth();
  pageWrapEl.scrollTop = 0;
  renderTree();
  editorInput.focus();
}

function isEntryFirstPage(pageId) {
  return pages.length > 0 && pages[0].id === pageId;
}

// Plain is meant to be a truly blank page — no title bar at all, write
// from the very top. Every other type still shows a title on the entry's
// first page, as before.
function shouldHideTitle(page) {
  if (!page) return true;
  if (page.note_type === "plain") return true;
  return !isEntryFirstPage(page.id);
}

let markdownPreviewOn = false;

function loadPageIntoEditor(pageId) {
  const page = pages.find((p) => p.id === pageId);
  if (!page) return;
  suppressReflow = true;
  editorInput.value = page.content || "";
  suppressReflow = false;
  applyAppearance(page.note_type || "plain", page.theme || "classic", page.font_size || 15);
  titleInput.classList.toggle("title-hidden", shouldHideTitle(page));
  markdownPreviewOn = false;
  setMarkdownPreviewVisible(false);
  markdownPreviewBtn.classList.toggle("hidden", page.note_type !== "markdown");
}

function applyAppearance(noteType, theme, fontSize) {
  pageEl.setAttribute("data-note-type", noteType);
  pageEl.setAttribute("data-theme", theme);
  pageEl.style.setProperty("--user-font-size", fontSize + "px");
  pageWrapEl.setAttribute("data-theme", theme);
  noteTypeSelect.value = noteType;
  themeSelect.value = theme;
  fontSizeSelect.value = String(fontSize);
}

// ---------- Page tabs ----------
function renderPageTabs() {
  pageTabsEl.classList.toggle("tabs-visible", pages.length > 1);
  pageTabsEl.innerHTML = "";
  if (pages.length <= 1) return;

  const labels = pages.map((p, i) => {
    const sameTypeRunLength = pages.filter((q) => q.note_type === p.note_type).length;
    if (sameTypeRunLength <= 1) return NOTE_TYPE_LABELS[p.note_type] || p.note_type;
    const indexWithinType = pages.slice(0, i + 1).filter((q) => q.note_type === p.note_type).length;
    return `${NOTE_TYPE_LABELS[p.note_type] || p.note_type} ${indexWithinType}`;
  });

  pages.forEach((page, i) => {
    const tab = document.createElement("div");
    tab.className = "page-tab" + (page.id === currentPageId ? " active" : "");
    tab.innerHTML = `
      <span>${labels[i]}</span>
      <span class="tab-close" title="Delete this page">✕</span>
    `;
    tab.querySelector("span").addEventListener("click", () => switchToPage(page.id));
    tab.querySelector(".tab-close").addEventListener("click", (e) => {
      e.stopPropagation();
      deletePage(page.id);
    });
    pageTabsEl.appendChild(tab);
  });
}

async function switchToPage(pageId) {
  if (pageId === currentPageId) return;
  await flushSave();
  currentPageId = pageId;
  loadPageIntoEditor(pageId);
  renderPageTabs();
  fitToWidth();
  pageWrapEl.scrollTop = 0;
}

async function deletePage(pageId) {
  if (pages.length <= 1) {
    alert("An entry needs at least one page.");
    return;
  }
  if (!confirm("Delete this page?")) return;
  await idbDelete("pages", pageId);

  pages = pages.filter((p) => p.id !== pageId);
  renumberPositions();
  if (currentPageId === pageId) {
    currentPageId = pages[0].id;
    loadPageIntoEditor(currentPageId);
  }
  renderPageTabs();
  persistDirtyPages();
}

function showEditor() {
  pageEl.classList.remove("hidden");
  pageTabsEl.classList.remove("hidden");
  emptyState.classList.add("hidden");
}
function showEmptyState() {
  pageEl.classList.add("hidden");
  pageTabsEl.classList.add("hidden");
  emptyState.classList.remove("hidden");
}

// ---------- Saving ----------
function scheduleSave() {
  saveStatus.textContent = "Saving...";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrent, 400);
}

async function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  await saveCurrent();
}

async function persistDirtyPages() {
  const jobs = [];
  for (const pageId of dirtyPageIds) {
    const page = pages.find((p) => p.id === pageId);
    if (page) jobs.push(idbPut("pages", page));
  }
  dirtyPageIds.clear();
  await Promise.all(jobs);
}

async function saveCurrent() {
  if (!currentEntryId) return;

  if (titleDirty) {
    const entry = entries.find((e) => e.id === currentEntryId);
    if (entry) {
      entry.title = titleInput.value;
      await idbPut("entries", entry);
    }
    titleDirty = false;
  }

  await persistDirtyPages();
  saveStatus.textContent = "Saved";
  renderTree();
}

titleInput.addEventListener("input", () => {
  titleDirty = true;
  scheduleSave();
});

// ---------- Pagination engine ----------
function getChainIndices(pageId) {
  const idx = pages.findIndex((p) => p.id === pageId);
  if (idx === -1) return [idx, idx];
  const type = pages[idx].note_type;
  let start = idx;
  while (start > 0 && pages[start - 1].note_type === type) start--;
  let end = idx;
  while (end < pages.length - 1 && pages[end + 1].note_type === type) end++;
  return [start, end];
}

function measureFitLength(text, maxHeight, widthPx) {
  const style = getComputedStyle(editorInput);
  measureMirror.style.width = widthPx + "px";
  measureMirror.style.fontFamily = style.fontFamily;
  measureMirror.style.fontSize = style.fontSize;
  measureMirror.style.lineHeight = style.lineHeight;
  measureMirror.style.letterSpacing = style.letterSpacing;

  if (text.length === 0) return 0;

  let lo = 0, hi = text.length, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    measureMirror.textContent = text.slice(0, mid);
    if (measureMirror.scrollHeight <= maxHeight) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function availableHeightFor(page, forFirstEntryPage) {
  const style = getComputedStyle(pageEl);
  const padTop = parseFloat(style.paddingTop);
  const padBottom = parseFloat(style.paddingBottom);
  let interior = pageEl.clientHeight - padTop - padBottom;
  if (forFirstEntryPage) {
    const titleStyle = getComputedStyle(titleInput);
    interior -= titleInput.offsetHeight + parseFloat(titleStyle.marginBottom || 0);
  }
  return Math.max(interior, 40);
}

function renumberPositions() {
  pages.forEach((p, i) => {
    if (p.position !== i) {
      p.position = i;
      dirtyPageIds.add(p.id);
    }
  });
}

// A brief, tangible pulse so it's obvious you've landed on a new (or
// previous) page, rather than the content just silently changing underneath you.
function flashPageTransition() {
  pageEl.classList.remove("page-flash");
  void pageEl.offsetWidth; // restart the animation even if triggered again quickly
  pageEl.classList.add("page-flash");
  setTimeout(() => pageEl.classList.remove("page-flash"), 500);
}

// Keeps the caret visible as you type past the bottom of the visible
// viewport — necessary because the page can be taller than the window,
// and the browser's native "scroll input into view" doesn't reliably
// account for our zoom transform.
function scrollCaretIntoView() {
  const textBeforeCaret = editorInput.value.slice(0, editorInput.selectionStart);
  const style = getComputedStyle(editorInput);
  measureMirror.style.width = editorInput.clientWidth + "px";
  measureMirror.style.fontFamily = style.fontFamily;
  measureMirror.style.fontSize = style.fontSize;
  measureMirror.style.lineHeight = style.lineHeight;
  measureMirror.style.letterSpacing = style.letterSpacing;
  measureMirror.textContent = textBeforeCaret || " ";
  const caretYUnscaled = measureMirror.scrollHeight;

  const editorRect = editorInput.getBoundingClientRect();
  const wrapRect = pageWrapEl.getBoundingClientRect();
  const caretScreenY = editorRect.top + caretYUnscaled * zoom;
  const margin = 32;

  if (caretScreenY > wrapRect.bottom - margin) {
    pageWrapEl.scrollTop += caretScreenY - wrapRect.bottom + margin;
  } else if (caretScreenY < wrapRect.top + margin) {
    pageWrapEl.scrollTop -= wrapRect.top + margin - caretScreenY;
  }
}

function reflowChain(chainStart, chainEnd, fullText, caretAbsOffset) {
  const templatePage = pages[chainStart];
  const width = editorInput.clientWidth;

  const chunks = [];
  let remaining = fullText;
  let firstChunk = true;

  while (true) {
    const forFirst = firstChunk && chainStart === 0;
    const maxHeight = availableHeightFor(templatePage, forFirst);
    const fitLen = measureFitLength(remaining, maxHeight, width);

    if (remaining.length === 0) {
      chunks.push("");
      break;
    }
    if (fitLen >= remaining.length) {
      chunks.push(remaining);
      break;
    }
    let breakAt = fitLen;
    const lookback = remaining.lastIndexOf(" ", fitLen);
    if (lookback > fitLen - 20 && lookback > 0) breakAt = lookback + 1;
    if (breakAt <= 0) breakAt = Math.max(fitLen, 1);

    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt);
    firstChunk = false;
  }

  const existingChainPages = pages.slice(chainStart, chainEnd + 1);
  const resultPages = [];

  for (let i = 0; i < chunks.length; i++) {
    if (i < existingChainPages.length) {
      const page = existingChainPages[i];
      if (page.content !== chunks[i]) {
        page.content = chunks[i];
        dirtyPageIds.add(page.id);
      }
      resultPages.push(page);
    } else {
      const newPage = {
        id: newId(),
        entry_id: currentEntryId,
        note_type: templatePage.note_type,
        theme: templatePage.theme,
        font_size: templatePage.font_size,
        content: chunks[i],
        position: 0,
      };
      resultPages.push(newPage);
      dirtyPageIds.add(newPage.id);
    }
  }

  for (let i = chunks.length; i < existingChainPages.length; i++) {
    const stale = existingChainPages[i];
    dirtyPageIds.delete(stale.id);
    idbDelete("pages", stale.id).catch(console.error);
  }

  pages.splice(chainStart, existingChainPages.length, ...resultPages);
  renumberPositions();

  let cumulative = 0;
  let targetPage = resultPages[resultPages.length - 1];
  let localOffset = chunks[chunks.length - 1].length;
  for (let i = 0; i < resultPages.length; i++) {
    const len = chunks[i].length;
    if (caretAbsOffset <= cumulative + len) {
      targetPage = resultPages[i];
      localOffset = caretAbsOffset - cumulative;
      break;
    }
    cumulative += len;
  }

  return { targetPageId: targetPage.id, localOffset };
}

function runReflowFromEditor() {
  if (!currentPageId) return;
  const previousPageId = currentPageId;

  const [chainStart, chainEnd] = getChainIndices(currentPageId);
  const currentIdxInChain = pages.findIndex((p) => p.id === currentPageId) - chainStart;

  const before = pages.slice(chainStart, chainStart + currentIdxInChain).map((p) => p.content).join("");
  const after = pages.slice(chainStart + currentIdxInChain + 1, chainEnd + 1).map((p) => p.content).join("");
  const fullText = before + editorInput.value + after;
  const caretAbsOffset = before.length + editorInput.selectionStart;

  const { targetPageId, localOffset } = reflowChain(chainStart, chainEnd, fullText, caretAbsOffset);

  currentPageId = targetPageId;
  const targetPage = pages.find((p) => p.id === targetPageId);

  suppressReflow = true;
  editorInput.value = targetPage.content;
  suppressReflow = false;
  editorInput.selectionStart = localOffset;
  editorInput.selectionEnd = localOffset;
  titleInput.classList.toggle("title-hidden", shouldHideTitle(targetPage));
  if (currentPageId !== previousPageId) flashPageTransition();

  renderPageTabs();
  scheduleSave();
  scrollCaretIntoView();
}

editorInput.addEventListener("input", () => {
  if (suppressReflow) return;
  runReflowFromEditor();
});

editorInput.addEventListener("keydown", (e) => {
  const atStart = editorInput.selectionStart === 0 && editorInput.selectionEnd === 0;
  const atEnd =
    editorInput.selectionStart === editorInput.value.length &&
    editorInput.selectionEnd === editorInput.value.length;

  if (e.key === "Backspace" && atStart) {
    const [chainStart] = getChainIndices(currentPageId);
    const idx = pages.findIndex((p) => p.id === currentPageId);
    if (idx > chainStart) {
      e.preventDefault();
      mergeAcrossBoundary(-1);
    }
  } else if (e.key === "Delete" && atEnd) {
    const [, chainEnd] = getChainIndices(currentPageId);
    const idx = pages.findIndex((p) => p.id === currentPageId);
    if (idx < chainEnd) {
      e.preventDefault();
      mergeAcrossBoundary(1);
    }
  }
});

function mergeAcrossBoundary(direction) {
  const [chainStart, chainEnd] = getChainIndices(currentPageId);
  const currentIdxInChain = pages.findIndex((p) => p.id === currentPageId) - chainStart;

  const before = pages.slice(chainStart, chainStart + currentIdxInChain).map((p) => p.content).join("");
  const after = pages.slice(chainStart + currentIdxInChain + 1, chainEnd + 1).map((p) => p.content).join("");
  const fullText = before + editorInput.value + after;
  let caretAbsOffset = before.length + editorInput.selectionStart;

  const newFullText =
    direction === -1
      ? fullText.slice(0, caretAbsOffset - 1) + fullText.slice(caretAbsOffset)
      : fullText.slice(0, caretAbsOffset) + fullText.slice(caretAbsOffset + 1);
  if (direction === -1) caretAbsOffset -= 1;

  const { targetPageId, localOffset } = reflowChain(chainStart, chainEnd, newFullText, caretAbsOffset);

  currentPageId = targetPageId;
  const targetPage = pages.find((p) => p.id === targetPageId);

  suppressReflow = true;
  editorInput.value = targetPage.content;
  suppressReflow = false;
  editorInput.selectionStart = localOffset;
  editorInput.selectionEnd = localOffset;
  titleInput.classList.toggle("title-hidden", shouldHideTitle(targetPage));
  flashPageTransition();
  editorInput.focus();

  renderPageTabs();
  scheduleSave();
  scrollCaretIntoView();
}

// ---------- Markdown preview (Markdown note type only) ----------
function escapeForHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Deliberately minimal — headings, bold, italic, bullet lists, paragraphs.
// This is a writing app, not a full CommonMark implementation.
function renderMarkdown(text) {
  const lines = escapeForHtml(text).split("\n");
  const htmlParts = [];
  let listOpen = false;

  const closeList = () => {
    if (listOpen) {
      htmlParts.push("</ul>");
      listOpen = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine;
    let inline = line
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>");

    if (/^#\s+/.test(line)) {
      closeList();
      htmlParts.push(`<h1>${inline.replace(/^#\s+/, "")}</h1>`);
    } else if (/^##\s+/.test(line)) {
      closeList();
      htmlParts.push(`<h2>${inline.replace(/^##\s+/, "")}</h2>`);
    } else if (/^-\s+/.test(line)) {
      if (!listOpen) {
        htmlParts.push("<ul>");
        listOpen = true;
      }
      htmlParts.push(`<li>${inline.replace(/^-\s+/, "")}</li>`);
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      htmlParts.push(`<p>${inline}</p>`);
    }
  }
  closeList();
  return htmlParts.join("");
}

function setMarkdownPreviewVisible(visible) {
  editorInput.classList.toggle("hidden", visible);
  markdownPreviewEl.classList.toggle("hidden", !visible);
  markdownPreviewBtn.classList.toggle("active-preview", visible);
  if (visible) {
    markdownPreviewEl.innerHTML = renderMarkdown(editorInput.value);
  }
}

markdownPreviewBtn.addEventListener("click", () => {
  markdownPreviewOn = !markdownPreviewOn;
  setMarkdownPreviewVisible(markdownPreviewOn);
  if (!markdownPreviewOn) editorInput.focus();
});

// ---------- Ribbon controls: font size, note type, theme ----------
fontSizeSelect.addEventListener("change", () => {
  const page = pages.find((p) => p.id === currentPageId);
  if (!page) return;
  const size = parseInt(fontSizeSelect.value, 10);
  page.font_size = size;
  dirtyPageIds.add(page.id);
  pageEl.style.setProperty("--user-font-size", size + "px");
  // Capacity per page changes with font size, so re-split the whole chain.
  runReflowFromEditor();
});

noteTypeSelect.addEventListener("change", async () => {
  const newType = noteTypeSelect.value;
  const page = pages.find((p) => p.id === currentPageId);
  if (!page) return;

  if (editorInput.value.trim() === "") {
    page.note_type = newType;
    dirtyPageIds.add(page.id);
    pageEl.setAttribute("data-note-type", newType);
    titleInput.classList.toggle("title-hidden", shouldHideTitle(page));
    markdownPreviewOn = false;
    setMarkdownPreviewVisible(false);
    markdownPreviewBtn.classList.toggle("hidden", newType !== "markdown");
    fitToWidth();
    scheduleSave();
    return;
  }

  await flushSave();

  const newPage = {
    id: newId(),
    entry_id: currentEntryId,
    note_type: newType,
    theme: page.theme,
    font_size: page.font_size,
    content: "",
    position: pages.length,
  };
  await idbPut("pages", newPage);

  pages.push(newPage);
  renumberPositions();
  currentPageId = newPage.id;
  loadPageIntoEditor(currentPageId);
  renderPageTabs();
  fitToWidth();
});

themeSelect.addEventListener("change", () => {
  const page = pages.find((p) => p.id === currentPageId);
  if (!page) return;
  page.theme = themeSelect.value;
  dirtyPageIds.add(page.id);
  pageEl.setAttribute("data-theme", themeSelect.value);
  pageWrapEl.setAttribute("data-theme", themeSelect.value);
  scheduleSave();
});

// ---------- Formatting buttons ----------
document.querySelectorAll(".ribbon-btn[data-action]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const action = btn.dataset.action;
    const wraps = {
      h1: ["# ", ""],
      h2: ["## ", ""],
      bold: ["**", "**"],
      italic: ["*", "*"],
      list: ["- ", ""],
    };
    const [before, after] = wraps[action];
    wrapSelection(before, after);
  });
});

function wrapSelection(before, after) {
  const start = editorInput.selectionStart;
  const end = editorInput.selectionEnd;
  const val = editorInput.value;
  const selected = val.substring(start, end) || "text";
  editorInput.value = val.substring(0, start) + before + selected + after + val.substring(end);
  editorInput.selectionStart = start + before.length;
  editorInput.selectionEnd = start + before.length + selected.length;
  editorInput.focus();
  runReflowFromEditor();
  scrollCaretIntoView();
}

// ---------- Fit-to-width view, native scroll, zoom-to-shrink ----------
let zoom = 1;
let isManualZoom = false;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;
const VIEW_SIDE_INSET = 48;

function updateCanvasScale() {
  const w = canvasEl.offsetWidth;
  const h = canvasEl.offsetHeight;
  zoomOuterEl.style.width = w * zoom + "px";
  zoomOuterEl.style.height = h * zoom + "px";
  canvasEl.style.transform = `scale(${zoom})`;
  zoomLevelEl.textContent = `${Math.round(zoom * 100)}%`;
}

function fitToWidth() {
  const available = pageWrapEl.clientWidth - VIEW_SIDE_INSET;
  const pageWidth = pageEl.offsetWidth;
  if (pageWidth === 0) return;
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, available / pageWidth));
  isManualZoom = false;
  updateCanvasScale();
}

function zoomBy(factor) {
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * factor));
  isManualZoom = true;
  updateCanvasScale();
}

zoomInBtn.addEventListener("click", () => zoomBy(1.15));
zoomOutBtn.addEventListener("click", () => zoomBy(1 / 1.15));
zoomResetBtn.addEventListener("click", fitToWidth);

pageWrapEl.addEventListener(
  "wheel",
  (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.08 : 1 / 1.08);
  },
  { passive: false }
);

window.addEventListener("resize", () => {
  if (!isManualZoom) fitToWidth();
  else updateCanvasScale();
});

// ---------- PWA: offline support + installability ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.error(err));
  });
}

// The browser only offers to install once it judges the app installable
// (valid manifest + service worker + HTTPS). We capture that moment and
// hold onto it so our own ribbon button can trigger it on demand, instead
// of relying on the browser's own address-bar icon.
let deferredInstallPrompt = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  installBtn.classList.remove("hidden");
});

installBtn.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installBtn.classList.add("hidden");
});

window.addEventListener("appinstalled", () => {
  installBtn.classList.add("hidden");
  deferredInstallPrompt = null;
});

// ---------- Boot ----------
applyAppearance("plain", "classic", 15);
showEmptyState();
(async function init() {
  await loadData();
  await loadJournalName();
  await openStartingEntry();
})();
