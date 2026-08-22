// ---------- Configure these with your own Supabase project values ----------
const SUPABASE_URL = "https://pvsjtxysphjcvrpnuops.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_268WI6TaUndTf52fd_tdNg_MhF27h9j";
// -----------------------------------------------------------------------

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- DOM references ----------
const loginScreen = document.getElementById("login-screen");
const loginForm = document.getElementById("login-form");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const loginError = document.getElementById("login-error");
const loginBtn = document.getElementById("login-btn");

const appEl = document.getElementById("app");
const journalNameInput = document.getElementById("journal-name");
const treeEl = document.getElementById("tree");
const newFolderBtn = document.getElementById("new-folder-btn");
const newFileBtn = document.getElementById("new-file-btn");
const logoutBtn = document.getElementById("logout-btn");

const titleInput = document.getElementById("entry-title");
const editorInput = document.getElementById("entry-editor");
const pageWrapEl = document.getElementById("page-wrap");
const canvasEl = document.getElementById("canvas");
const pageEl = document.getElementById("page");
const pageTabsEl = document.getElementById("page-tabs");
const emptyState = document.getElementById("empty-state");
const saveStatus = document.getElementById("save-status");
const deleteEntryBtn = document.getElementById("delete-entry-btn");
const noteTypeSelect = document.getElementById("note-type-select");
const themeSelect = document.getElementById("theme-select");
const zoomInBtn = document.getElementById("zoom-in-btn");
const zoomOutBtn = document.getElementById("zoom-out-btn");
const zoomResetBtn = document.getElementById("zoom-reset-btn");
const zoomLevelEl = document.getElementById("zoom-level");

const NOTE_TYPE_LABELS = {
  plain: "Plain",
  scriptwriter: "Scriptwriter",
  author: "Author",
  diary: "Diary",
  postit: "Post-it",
};

// Hidden element used purely to measure how much text fits in a page's
// text area, by mirroring the editor's exact font/wrapping and binary
// searching for the longest prefix that still fits within a height budget.
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
let entries = [];               // lightweight: id, title, folder_id
let openFolderIds = new Set();
let currentEntryId = null;
let pages = [];                 // all pages belonging to the currently open entry, ordered by position
let currentPageId = null;
let saveTimer = null;
let journalNameSaveTimer = null;
let dirtyPageIds = new Set();   // pages whose content/type/theme/position changed locally, pending save
let titleDirty = false;
let suppressReflow = false;     // true while programmatically setting editorInput.value

// ---------- Auth ----------
async function init() {
  const { data } = await supabaseClient.auth.getSession();
  if (data.session) {
    showApp();
    await loadData();
    await loadJournalName();
    await openStartingEntry();
  } else {
    showLogin();
  }
}

function showLogin() {
  loginScreen.classList.remove("hidden");
  appEl.classList.add("hidden");
}

function showApp() {
  loginScreen.classList.add("hidden");
  appEl.classList.remove("hidden");
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";
  loginBtn.disabled = true;
  loginBtn.textContent = "Signing in...";

  const { error } = await supabaseClient.auth.signInWithPassword({
    email: emailInput.value.trim(),
    password: passwordInput.value,
  });

  loginBtn.disabled = false;
  loginBtn.textContent = "Sign in";

  if (error) {
    loginError.textContent = "Could not sign in. Check your email and password.";
    return;
  }

  showApp();
  await loadData();
  await loadJournalName();
  await openStartingEntry();
});

logoutBtn.addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  currentEntryId = null;
  currentPageId = null;
  showLogin();
});

// ---------- Journal name (top right, editable) ----------
async function loadJournalName() {
  const { data, error } = await supabaseClient.from("settings").select("journal_name").maybeSingle();

  if (error) {
    console.error(error);
    journalNameInput.value = "My notes";
    return;
  }

  if (!data) {
    const { data: created, error: createErr } = await supabaseClient
      .from("settings")
      .insert({ journal_name: "My notes" })
      .select("journal_name")
      .single();
    if (createErr) {
      console.error(createErr);
      journalNameInput.value = "My notes";
      return;
    }
    journalNameInput.value = created.journal_name;
    return;
  }

  journalNameInput.value = data.journal_name;
}

journalNameInput.addEventListener("input", () => {
  clearTimeout(journalNameSaveTimer);
  journalNameSaveTimer = setTimeout(saveJournalName, 500);
});

journalNameInput.addEventListener("blur", () => {
  clearTimeout(journalNameSaveTimer);
  saveJournalName();
});

async function saveJournalName() {
  const name = journalNameInput.value.trim() || "My notes";
  const { error } = await supabaseClient.from("settings").update({ journal_name: name }).select();
  if (error) console.error(error);
}

// ---------- Data loading ----------
async function loadData() {
  const [{ data: folderData, error: folderErr }, { data: entryData, error: entryErr }] =
    await Promise.all([
      supabaseClient.from("folders").select("*").order("created_at"),
      supabaseClient.from("entries").select("id, title, folder_id, created_at").order("created_at"),
    ]);

  if (folderErr || entryErr) {
    console.error(folderErr || entryErr);
    return;
  }

  folders = folderData;
  entries = entryData;
  renderTree();
}

async function openStartingEntry() {
  const untitledCandidates = entries.filter((e) => !e.title);

  for (const candidate of untitledCandidates) {
    const { data: candidatePages, error } = await supabaseClient
      .from("pages")
      .select("*")
      .eq("entry_id", candidate.id)
      .order("position");
    if (error) {
      console.error(error);
      continue;
    }
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
    row.querySelector(".row-label").addEventListener("click", () => openEntry(entry.id));
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
  const { data, error } = await supabaseClient
    .from("folders")
    .insert({ name, parent_id: currentParentFolderId() })
    .select()
    .single();
  if (error) return console.error(error);
  folders.push(data);
  if (data.parent_id) openFolderIds.add(data.parent_id);
  renderTree();
});

newFileBtn.addEventListener("click", createAndOpenNewEntry);

async function createAndOpenNewEntry() {
  const { data: entryData, error: entryErr } = await supabaseClient
    .from("entries")
    .insert({ title: "", folder_id: currentParentFolderId() })
    .select("id, title, folder_id, created_at")
    .single();
  if (entryErr) return console.error(entryErr);

  const { data: pageData, error: pageErr } = await supabaseClient
    .from("pages")
    .insert({ entry_id: entryData.id, note_type: "plain", theme: "classic", content: "", position: 0 })
    .select()
    .single();
  if (pageErr) return console.error(pageErr);

  entries.push(entryData);
  if (entryData.folder_id) openFolderIds.add(entryData.folder_id);
  renderTree();
  await openEntry(entryData.id, [pageData]);
}

function currentParentFolderId() {
  return null;
}

// ---------- Deleting ----------
async function deleteFolder(id) {
  if (!confirm("Delete this folder and everything inside it?")) return;
  const { error } = await supabaseClient.from("folders").delete().eq("id", id);
  if (error) return console.error(error);
  folders = folders.filter((f) => f.id !== id);
  entries = entries.filter((e) => e.folder_id !== id);
  renderTree();
}

async function deleteEntry(id) {
  if (!confirm("Delete this entry and all its pages?")) return;
  const { error } = await supabaseClient.from("entries").delete().eq("id", id);
  if (error) return console.error(error);
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

  if (preloadedPages) {
    pages = preloadedPages;
  } else {
    const { data, error } = await supabaseClient
      .from("pages")
      .select("*")
      .eq("entry_id", id)
      .order("position");
    if (error) {
      console.error(error);
      return;
    }
    pages = data && data.length ? data : [];
  }

  currentPageId = pages[0] ? pages[0].id : null;
  renderPageTabs();
  loadPageIntoEditor(currentPageId);
  showEditor();
  renderTree();
  editorInput.focus();
}

function isEntryFirstPage(pageId) {
  return pages.length > 0 && pages[0].id === pageId;
}

function loadPageIntoEditor(pageId) {
  const page = pages.find((p) => p.id === pageId);
  if (!page) return;
  suppressReflow = true;
  editorInput.value = page.content || "";
  suppressReflow = false;
  applyAppearance(page.note_type || "plain", page.theme || "classic");
  titleInput.classList.toggle("title-hidden", !isEntryFirstPage(pageId));
}

function applyAppearance(noteType, theme) {
  pageEl.setAttribute("data-note-type", noteType);
  pageEl.setAttribute("data-theme", theme);
  noteTypeSelect.value = noteType;
  themeSelect.value = theme;
}

// ---------- Page tabs ----------
function renderPageTabs() {
  pageTabsEl.innerHTML = "";
  if (pages.length <= 1) return;

  // Number consecutive pages that share a note type, e.g. "Plain 1", "Plain 2"
  const labels = pages.map((p, i) => {
    const sameTypeRunLength = pages.filter((q) => q.note_type === p.note_type).length;
    if (sameTypeRunLength <= 1) return NOTE_TYPE_LABELS[p.note_type] || p.note_type;
    const indexWithinType =
      pages.slice(0, i + 1).filter((q) => q.note_type === p.note_type).length;
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
}

async function deletePage(pageId) {
  if (pages.length <= 1) {
    alert("An entry needs at least one page.");
    return;
  }
  if (!confirm("Delete this page?")) return;
  const { error } = await supabaseClient.from("pages").delete().eq("id", pageId);
  if (error) return console.error(error);

  pages = pages.filter((p) => p.id !== pageId);
  renumberPositions();
  if (currentPageId === pageId) {
    currentPageId = pages[0].id;
    loadPageIntoEditor(currentPageId);
  }
  renderPageTabs();
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
  saveTimer = setTimeout(saveCurrent, 500);
}

async function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  await saveCurrent();
}

async function saveCurrent() {
  if (!currentEntryId) return;

  const jobs = [];

  if (titleDirty) {
    jobs.push(
      supabaseClient.from("entries").update({ title: titleInput.value }).eq("id", currentEntryId)
    );
    const entry = entries.find((e) => e.id === currentEntryId);
    if (entry) entry.title = titleInput.value;
    titleDirty = false;
  }

  for (const pageId of dirtyPageIds) {
    const page = pages.find((p) => p.id === pageId);
    if (!page) continue;
    jobs.push(
      supabaseClient
        .from("pages")
        .update({
          content: page.content,
          note_type: page.note_type,
          theme: page.theme,
          position: page.position,
        })
        .eq("id", page.id)
    );
  }
  dirtyPageIds.clear();

  if (jobs.length === 0) return;

  const results = await Promise.all(jobs);
  const failed = results.find((r) => r.error);
  if (failed) {
    saveStatus.textContent = "Could not save";
    console.error(failed.error);
    return;
  }

  saveStatus.textContent = "Saved";
  renderTree();
}

titleInput.addEventListener("input", () => {
  titleDirty = true;
  scheduleSave();
});

// ---------- Pagination engine ----------
// The whole idea: a run of pages sharing the same note type is one continuous
// document under the hood. On every keystroke we rebuild that full text,
// re-split it to fit the fixed page size, and figure out which resulting
// page the cursor now falls on — creating or removing linked pages as needed.

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

  let lo = 0;
  let hi = text.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    measureMirror.textContent = text.slice(0, mid);
    const h = measureMirror.scrollHeight;
    if (h <= maxHeight) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function availableHeightFor(page, forFirstEntryPage) {
  // Uses the live page element's own box, so it always matches current CSS.
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

// Rebuilds a chain of same-typed pages from `fullText`, splitting it across
// as many pages as needed, creating/removing pages to match, and returning
// which page + local offset a given absolute caret offset lands on.
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
    // Avoid splitting mid-word where a nearby space allows a cleaner break.
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
        id: "temp-" + Math.random().toString(36).slice(2),
        entry_id: currentEntryId,
        note_type: templatePage.note_type,
        theme: templatePage.theme,
        content: chunks[i],
        position: 0, // fixed up by renumberPositions()
      };
      resultPages.push(newPage);
      dirtyPageIds.add(newPage.id);
      persistNewPage(newPage);
    }
  }

  // Drop chain pages beyond what's now needed.
  for (let i = chunks.length; i < existingChainPages.length; i++) {
    const stale = existingChainPages[i];
    dirtyPageIds.delete(stale.id);
    if (!String(stale.id).startsWith("temp-")) {
      supabaseClient.from("pages").delete().eq("id", stale.id).then(({ error }) => {
        if (error) console.error(error);
      });
    }
  }

  pages.splice(chainStart, existingChainPages.length, ...resultPages);
  renumberPositions();

  // Locate which resulting page holds the caret.
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

// New pages created mid-reflow get a real id from Supabase in the background;
// we swap the temp id for the real one once it comes back so future saves work.
function persistNewPage(newPage) {
  supabaseClient
    .from("pages")
    .insert({
      entry_id: newPage.entry_id,
      note_type: newPage.note_type,
      theme: newPage.theme,
      content: newPage.content,
      position: newPage.position,
    })
    .select()
    .single()
    .then(({ data, error }) => {
      if (error) {
        console.error(error);
        return;
      }
      const stillDirty = dirtyPageIds.has(newPage.id);
      const idx = pages.findIndex((p) => p.id === newPage.id);
      if (idx !== -1) {
        pages[idx] = { ...pages[idx], id: data.id };
        if (currentPageId === newPage.id) currentPageId = data.id;
        dirtyPageIds.delete(newPage.id);
        if (stillDirty) dirtyPageIds.add(data.id);
        renderPageTabs();
      }
    });
}

function runReflowFromEditor() {
  if (!currentPageId) return;

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
  titleInput.classList.toggle("title-hidden", !isEntryFirstPage(currentPageId));

  renderPageTabs();
  scheduleSave();
}

editorInput.addEventListener("input", () => {
  if (suppressReflow) return;
  runReflowFromEditor();
});

// Backspace at the very start of a page reaches back into the previous page
// in the chain; Delete at the very end reaches forward into the next one.
// Both feel like flipping back/forward through continuous paper.
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
  titleInput.classList.toggle("title-hidden", !isEntryFirstPage(currentPageId));
  editorInput.focus();

  renderPageTabs();
  scheduleSave();
}

// ---------- Note type dropdown ----------
noteTypeSelect.addEventListener("change", async () => {
  const newType = noteTypeSelect.value;
  const page = pages.find((p) => p.id === currentPageId);
  if (!page) return;

  if (editorInput.value.trim() === "") {
    page.note_type = newType;
    dirtyPageIds.add(page.id);
    pageEl.setAttribute("data-note-type", newType);
    scheduleSave();
    return;
  }

  await flushSave();

  const { data: newPage, error } = await supabaseClient
    .from("pages")
    .insert({
      entry_id: currentEntryId,
      note_type: newType,
      theme: page.theme,
      content: "",
      position: pages.length,
    })
    .select()
    .single();

  if (error) {
    console.error(error);
    noteTypeSelect.value = page.note_type;
    return;
  }

  pages.push(newPage);
  renumberPositions();
  currentPageId = newPage.id;
  loadPageIntoEditor(currentPageId);
  renderPageTabs();
});

themeSelect.addEventListener("change", () => {
  const page = pages.find((p) => p.id === currentPageId);
  if (!page) return;
  page.theme = themeSelect.value;
  dirtyPageIds.add(page.id);
  pageEl.setAttribute("data-theme", themeSelect.value);
  scheduleSave();
});

// ---------- Toolbar formatting ----------
document.querySelectorAll(".tb-btn[data-action]").forEach((btn) => {
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
}

// ---------- Free-form pan & zoom of the paper ----------
let panX = 0;
let panY = 0;
let zoom = 1;
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 3;

function applyTransform() {
  canvasEl.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  zoomLevelEl.textContent = `${Math.round(zoom * 100)}%`;
}

function resetView() {
  panX = 0;
  panY = 0;
  zoom = 1;
  applyTransform();
}

function zoomBy(factor, centerX, centerY) {
  const rect = pageWrapEl.getBoundingClientRect();
  const cx = centerX !== undefined ? centerX - rect.left : rect.width / 2;
  const cy = centerY !== undefined ? centerY - rect.top : rect.height / 2;

  const pointX = (cx - panX) / zoom;
  const pointY = (cy - panY) / zoom;

  const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * factor));

  panX = cx - pointX * newZoom;
  panY = cy - pointY * newZoom;
  zoom = newZoom;
  applyTransform();
}

zoomInBtn.addEventListener("click", () => zoomBy(1.2));
zoomOutBtn.addEventListener("click", () => zoomBy(1 / 1.2));
zoomResetBtn.addEventListener("click", resetView);

pageWrapEl.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    zoomBy(factor, e.clientX, e.clientY);
  },
  { passive: false }
);

let isPanning = false;
let panStart = { x: 0, y: 0, panX: 0, panY: 0 };

function isInteractiveTarget(target) {
  return target.closest("input, textarea, button, select, .page-tab") !== null;
}

pageWrapEl.addEventListener("mousedown", (e) => {
  if (isInteractiveTarget(e.target)) return;
  isPanning = true;
  pageWrapEl.classList.add("panning");
  panStart = { x: e.clientX, y: e.clientY, panX, panY };
});

window.addEventListener("mousemove", (e) => {
  if (!isPanning) return;
  panX = panStart.panX + (e.clientX - panStart.x);
  panY = panStart.panY + (e.clientY - panStart.y);
  applyTransform();
});

window.addEventListener("mouseup", () => {
  if (!isPanning) return;
  isPanning = false;
  pageWrapEl.classList.remove("panning");
});

// ---------- Boot ----------
applyAppearance("plain", "classic");
applyTransform();
showEmptyState();
init();
