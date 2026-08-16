// ---------- Configure these with your own Supabase project values ----------
const SUPABASE_URL = "YOUR_SUPABASE_URL";
const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY";
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
const treeEl = document.getElementById("tree");
const newFolderBtn = document.getElementById("new-folder-btn");
const newFileBtn = document.getElementById("new-file-btn");
const logoutBtn = document.getElementById("logout-btn");

const titleInput = document.getElementById("entry-title");
const editorInput = document.getElementById("entry-editor");
const pageEl = document.getElementById("page");
const pageTabsEl = document.getElementById("page-tabs");
const emptyState = document.getElementById("empty-state");
const saveStatus = document.getElementById("save-status");
const deleteEntryBtn = document.getElementById("delete-entry-btn");
const noteTypeSelect = document.getElementById("note-type-select");
const themeSelect = document.getElementById("theme-select");

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

// ---------- Auth ----------
async function init() {
  const { data } = await supabaseClient.auth.getSession();
  if (data.session) {
    showApp();
    loadData();
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
  loadData();
});

logoutBtn.addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  currentEntryId = null;
  currentPageId = null;
  showLogin();
});

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
  showEmptyState();
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
    row.innerHTML = `
      <span class="row-icon">▤</span>
      <span class="row-label">${escapeHtml(entry.title || "Untitled entry")}</span>
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

newFileBtn.addEventListener("click", async () => {
  const { data: entryData, error: entryErr } = await supabaseClient
    .from("entries")
    .insert({ title: "Untitled entry", folder_id: currentParentFolderId() })
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
});

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
    showEmptyState();
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

  const newTitle = titleInput.value || "Untitled entry";
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

// ---------- Boot ----------
applyAppearance("plain", "classic");
showEmptyState();
init();
