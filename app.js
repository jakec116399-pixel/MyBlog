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

// ---------- State ----------
let folders = [];
let entries = [];               // lightweight: id, title, folder_id
let openFolderIds = new Set();
let currentEntryId = null;
let pages = [];                 // pages belonging to the currently open entry
let currentPageId = null;
let saveTimer = null;
let journalNameSaveTimer = null;

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
    // First time: create a settings row for this user.
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

// On login/load, get straight into a blank writable page with no clicking required.
// Reuses an existing empty, untitled entry if one is sitting around from last time,
// rather than piling up a fresh blank entry on every visit.
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
    row.querySelector(".row-label").addEventListener("click", () => {
      toggleFolder(folder.id);
    });
    row.querySelector(".chevron").addEventListener("click", () => {
      toggleFolder(folder.id);
    });
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
  if (openFolderIds.has(id)) {
    openFolderIds.delete(id);
  } else {
    openFolderIds.add(id);
  }
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

// New items are added at the root for simplicity; open the folder you want
// items filed into if you'd rather nest them, then use the tree row menu (future enhancement).
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

function loadPageIntoEditor(pageId) {
  const page = pages.find((p) => p.id === pageId);
  if (!page) return;
  editorInput.value = page.content || "";
  applyAppearance(page.note_type || "plain", page.theme || "classic");
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
  if (pages.length <= 1) return; // no need to show tabs for a single page

  pages.forEach((page) => {
    const tab = document.createElement("div");
    tab.className = "page-tab" + (page.id === currentPageId ? " active" : "");
    tab.innerHTML = `
      <span>${NOTE_TYPE_LABELS[page.note_type] || page.note_type}</span>
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
  saveTimer = setTimeout(saveCurrent, 600);
}

// Immediately persist any pending edit, e.g. before switching pages/entries.
async function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  await saveCurrent();
}

async function saveCurrent() {
  if (!currentEntryId || !currentPageId) return;

  const newTitle = titleInput.value; // no forced fallback text — empty stays empty
  const page = pages.find((p) => p.id === currentPageId);

  const [{ error: entryErr }, { error: pageErr }] = await Promise.all([
    supabaseClient.from("entries").update({ title: newTitle }).eq("id", currentEntryId),
    supabaseClient
      .from("pages")
      .update({ content: editorInput.value, note_type: page.note_type, theme: page.theme })
      .eq("id", currentPageId),
  ]);

  if (entryErr || pageErr) {
    saveStatus.textContent = "Could not save";
    console.error(entryErr || pageErr);
    return;
  }

  const entry = entries.find((e) => e.id === currentEntryId);
  if (entry) entry.title = newTitle;
  page.content = editorInput.value;

  saveStatus.textContent = "Saved";
  renderTree();
}

titleInput.addEventListener("input", scheduleSave);
editorInput.addEventListener("input", scheduleSave);

// ---------- Note type dropdown ----------
// Blank current page -> overwrite its type in place.
// Page has content -> spin off a new page, switch to it, leave the original untouched.
noteTypeSelect.addEventListener("change", async () => {
  const newType = noteTypeSelect.value;
  const page = pages.find((p) => p.id === currentPageId);
  if (!page) return;

  if (editorInput.value.trim() === "") {
    page.note_type = newType;
    pageEl.setAttribute("data-note-type", newType);
    scheduleSave();
    return;
  }

  await flushSave();

  const nextPosition = pages.length ? Math.max(...pages.map((p) => p.position)) + 1 : 0;
  const { data: newPage, error } = await supabaseClient
    .from("pages")
    .insert({
      entry_id: currentEntryId,
      note_type: newType,
      theme: page.theme,
      content: "",
      position: nextPosition,
    })
    .select()
    .single();

  if (error) {
    console.error(error);
    noteTypeSelect.value = page.note_type; // revert dropdown on failure
    return;
  }

  pages.push(newPage);
  currentPageId = newPage.id;
  loadPageIntoEditor(currentPageId);
  renderPageTabs();
});

// Theme always overwrites the current page's theme in place, regardless of content.
themeSelect.addEventListener("change", () => {
  const page = pages.find((p) => p.id === currentPageId);
  if (!page) return;
  page.theme = themeSelect.value;
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
  editorInput.focus();
  editorInput.selectionStart = start + before.length;
  editorInput.selectionEnd = start + before.length + selected.length;
  scheduleSave();
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

// Dragging the paper (or the desk around it) pans the view. Dragging inside
// the title field or the text itself still just places the cursor, as normal.
let isPanning = false;
let panStart = { x: 0, y: 0, panX: 0, panY: 0 };

function isInteractiveTarget(target) {
  return (
    target.closest("input, textarea, button, select, .page-tab") !== null
  );
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
