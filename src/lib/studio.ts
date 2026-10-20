/* Writing Studio — Vditor-powered Markdown workspace.
 * Loaded only on /admin/writing/. All persistence goes through the
 * authenticated Worker API (D1). Browser storage is only a crash-recovery stash.
 */
import Vditor from "vditor";
import "vditor/dist/index.css";

interface DocMeta {
  id: number;
  title: string;
  document_type: string;
  folder_id: number | null;
  status: string;
  is_pinned: boolean;
  tags: string;
  version: number;
  word_count: number;
  created_at: string;
  updated_at: string;
  publish_state: string;
  slug: string | null;
  excerpt: string;
  published_at: string | null;
  sync_state: string;
}
interface FullDoc extends DocMeta {
  markdown_content: string;
}
interface Folder {
  id: number;
  name: string;
  parent_id: number | null;
  doc_count: number;
}
interface Revision {
  id: number;
  title: string;
  version: number;
  reason: string;
  created_at: string;
  preview: string;
}

declare global {
  interface Window {
    AdminAPI: {
      api: (path: string, opts?: any) => Promise<any>;
      ready: Promise<void>;
      toast: (msg: string, isErr?: boolean) => void;
      esc: (s: any) => string;
      API: string;
    };
  }
}

const TYPE_LABELS: Record<string, string> = {
  note: "یادداشت",
  article: "مقاله",
  docs: "مستندات",
  research: "پژوهش",
  newsletter: "خبرنامه",
};
const AUTOSAVE_MS = 2500;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const faNum = (n: number | string) => Number(n).toLocaleString("fa-IR");
const faDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleString("fa-IR", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
};

function countWords(t: string): number {
  const m = (t || "").match(/[\p{L}\p{N}]+/gu);
  return m ? m.length : 0;
}

export function initStudio() {
  let token = "";
  let vditor: Vditor | null = null;
  let editorReady = false;
  let docs: DocMeta[] = [];
  let folders: Folder[] = [];
  let current: FullDoc | null = null;
  let dirty = false;
  let saving = false;
  let saveTimer: number | null = null;
  let stashTimer: number | null = null;
  let mode: "wysiwyg" | "ir" | "sv" = (localStorage.getItem("ahura-studio-mode") as any) || "ir";
  if (!["wysiwyg", "ir", "sv"].includes(mode)) mode = "ir";
  let activeFolder: number | "all" = "all";
  let searchQ = "";
  let searchTimer: number | null = null;

  const A = () => window.AdminAPI;
  const api = (path: string, opts?: any) => A().api(path, opts);
  const esc = (s: any) => A().esc(s);
  const toast = (m: string, e?: boolean) => A().toast(m, e);

  const isDark = () =>
    document.documentElement.classList.contains("dark") ||
    localStorage.getItem("ahura-theme") !== "light";

  /* ---------------- Vditor lifecycle ---------------- */

  function vditorOptions(value: string): any {
    const dark = isDark();
    const base = (import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");
    return {
      cdn: base + "vditor-dist",
      lang: "en_US",
      mode,
      value,
      theme: dark ? "dark" : "classic",
      cache: { enable: false },
      counter: { enable: false },
      outline: { enable: true },
      preview: {
        theme: { current: dark ? "dark" : "light" },
        hljs: { enable: true, style: dark ? "github-dark" : "github", lineNumber: true },
        math: { engine: "KaTeX" },
        markdown: { toc: true, footnotes: true },
      },
      upload: {
        url: A().API + "/api/admin/upload",
        fieldName: "file[]",
        max: 2 * 1024 * 1024,
        accept: "image/png,image/jpeg,image/webp,image/gif",
        multiple: true,
        filename: (name: string) => name,
        setHeaders: () => ({ Authorization: "Bearer " + token }),
        format: (files: File[], responseText: string) => {
          try {
            const data = JSON.parse(responseText);
            const succMap: Record<string, string> = {};
            for (const f of data.files || []) succMap[f.name] = f.url;
            return JSON.stringify({ code: 0, msg: "", data: { errFiles: [], succMap } });
          } catch {
            return JSON.stringify({
              code: 1,
              msg: "upload failed",
              data: { errFiles: files.map((f) => f.name), succMap: {} },
            });
          }
        },
        error: (msg: string) => toast("خطا در آپلود عکس: " + msg, true),
      },
      toolbar: [
        "emoji", "headings", "bold", "italic", "strike", "link", "|",
        "list", "ordered-list", "check", "outdent", "indent", "|",
        "quote", "line", "code", "inline-code", "insert-before", "insert-after", "|",
        "upload", "table", "|",
        "undo", "redo", "|",
        "outline", "preview", "fullscreen", "code-theme", "content-theme", "info",
      ],
      after: () => {
        editorReady = true;
        updateStats();
      },
      input: (value: string) => {
        if (!current) return;
        onEdit(value);
      },
      blur: () => {
        if (dirty && current) void saveDoc(false);
      },
      keydown: (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          void saveDoc(true);
        }
      },
    };
  }

  function initEditor(value: string) {
    if (vditor) {
      try {
        vditor.destroy();
      } catch {
        /* noop */
      }
      vditor = null;
    }
    editorReady = false;
    vditor = new Vditor($("vditor"), vditorOptions(value));
    syncModeButtons();
  }

  function syncModeButtons() {
    document.querySelectorAll("#modeSwitcher button").forEach((b) => {
      b.classList.toggle("on", (b as HTMLElement).dataset.mode === mode);
    });
  }

  async function switchMode(next: "wysiwyg" | "ir" | "sv") {
    if (next === mode || !vditor) {
      mode = next;
      localStorage.setItem("ahura-studio-mode", mode);
      syncModeButtons();
      return;
    }
    const value = vditor.getValue();
    mode = next;
    localStorage.setItem("ahura-studio-mode", mode);
    initEditor(value);
    toast("حالت ویرایش تغییر کرد.");
  }

  /* ---------------- save / autosave ---------------- */

  function setSaveStatus(state: "idle" | "dirty" | "saving" | "saved" | "error", text?: string) {
    const el = $("saveStatus");
    el.className = "st-save-status" + (state === "saving" ? " saving" : state === "saved" ? " saved" : state === "error" ? " error" : "");
    el.textContent =
      text ||
      (state === "dirty" ? "● تغییرات ذخیره‌نشده" : state === "saving" ? "در حال ذخیره..." : state === "saved" ? "✓ ذخیره شد" : state === "error" ? "✕ خطا در ذخیره" : "");
  }

  function stashRecovery() {
    if (!current || !vditor) return;
    try {
      localStorage.setItem(
        "ahura-studio-recovery-" + current.id,
        JSON.stringify({ content: vditor.getValue(), title: ($("docTitle") as HTMLInputElement).value, savedAt: Date.now() })
      );
    } catch {
      /* storage full — ignore */
    }
  }

  function clearRecovery(id: number) {
    try {
      localStorage.removeItem("ahura-studio-recovery-" + id);
    } catch {
      /* noop */
    }
  }

  function onEdit(_value: string) {
    dirty = true;
    setSaveStatus("dirty");
    updateStats();
    if (stashTimer) window.clearTimeout(stashTimer);
    stashTimer = window.setTimeout(stashRecovery, 1000);
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void saveDoc(false), AUTOSAVE_MS);
  }

  async function saveDoc(manual: boolean): Promise<boolean> {
    if (!current || !vditor || !editorReady || saving) return false;
    if (!dirty && !manual) return true;
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    saving = true;
    setSaveStatus("saving");
    const payload: Record<string, any> = {
      title: ($("docTitle") as HTMLInputElement).value.trim() || "Untitled",
      markdown_content: vditor.getValue(),
      document_type: ($("metaType") as HTMLSelectElement).value,
      folder_id: ($("metaFolder") as HTMLSelectElement).value ? parseInt(($("metaFolder") as HTMLSelectElement).value, 10) : null,
      tags: ($("metaTags") as HTMLInputElement).value,
      excerpt: ($("excerptInput") as HTMLTextAreaElement).value,
      version: current.version,
      manual,
    };
    // Slug: only send when empty or a valid URL segment, so a half-typed
    // slug can never break autosave; publish validates strictly server-side.
    const slugRaw = ($("slugInput") as HTMLInputElement).value.trim();
    if (slugRaw === "" || SLUG_RE.test(slugRaw)) payload.slug = slugRaw || null;
    try {
      const res = await api(`/api/admin/documents/${current.id}`, { method: "PUT", body: payload });
      current.version = res.version;
      current.title = payload.title;
      current.document_type = payload.document_type;
      current.folder_id = payload.folder_id;
      current.tags = payload.tags;
      current.updated_at = res.updated_at;
      current.markdown_content = payload.markdown_content;
      if ("slug" in payload) current.slug = payload.slug;
      current.excerpt = payload.excerpt;
      // Mirroring the server: edits on a published document stale its git copy.
      if (current.publish_state === "published") current.sync_state = "dirty";
      updatePublishUI();
      dirty = false;
      saving = false;
      clearRecovery(current.id);
      setSaveStatus("saved");
      window.setTimeout(() => {
        if (!dirty) setSaveStatus("idle");
      }, 2500);
      void refreshList(false);
      if (manual) {
        toast("ذخیره شد و نسخه ثبت شد.");
        void loadRevisions();
      }
      return true;
    } catch (e: any) {
      saving = false;
      if (e.message === "version_conflict") {
        showConflict(e.current_version);
        setSaveStatus("error", "✕ تداخل نسخه");
      } else {
        setSaveStatus("error");
        toast("ذخیره ناموفق بود؛ متنت محفوظه، دوباره تلاش می‌شه.", true);
        if (saveTimer) window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => void saveDoc(false), 15000);
      }
      return false;
    }
  }

  function showConflict(serverVersion: number) {
    const b = $("conflictBanner");
    b.hidden = false;
    b.innerHTML =
      `<span>این سند در جای دیگری تغییر کرده (نسخه‌ی سرور: ${faNum(serverVersion)}). متن فعلی تو محفوظه.</span>` +
      `<button id="cfLoad">بارگذاری نسخه‌ی سرور</button>` +
      `<button id="cfCopy">ذخیره‌ی متن من به‌عنوان سند جدید</button>` +
      `<button id="cfDismiss">بستن</button>`;
    ($("cfLoad") as HTMLButtonElement).onclick = async () => {
      if (!confirm("متن فعلی‌ات با نسخه‌ی سرور جایگزین می‌شه. مطمئنی؟")) return;
      b.hidden = true;
      if (current) {
        clearRecovery(current.id);
        await openDoc(current.id);
      }
    };
    ($("cfCopy") as HTMLButtonElement).onclick = async () => {
      if (!current || !vditor) return;
      const content = vditor.getValue();
      const title = ($("docTitle") as HTMLInputElement).value.trim() || "Untitled";
      const res = await api("/api/admin/documents", {
        method: "POST",
        body: { title: title + " (کپی)", document_type: current.document_type, markdown_content: content },
      });
      b.hidden = true;
      toast("به‌عنوان سند جدید ذخیره شد.");
      await refreshList(true);
      await openDoc(res.document.id);
    };
    ($("cfDismiss") as HTMLButtonElement).onclick = () => {
      b.hidden = true;
    };
  }

  /* ---------------- document list ---------------- */

  async function refreshList(resetScroll: boolean) {
    const status = ($("filterStatus") as HTMLSelectElement).value || "active";
    const type = ($("filterType") as HTMLSelectElement).value;
    const params = new URLSearchParams({ status, per_page: "100", sort: "updated" });
    if (type) params.set("type", type);
    if (activeFolder !== "all") params.set("folder_id", String(activeFolder));
    if (searchQ) params.set("q", searchQ);
    const res = await api("/api/admin/documents?" + params.toString());
    docs = res.documents || [];
    renderDocList();
    if (resetScroll) ($("docList") as HTMLElement).scrollTop = 0;
  }

  function renderDocList() {
    const list = $("docList");
    const empty = $("docListEmpty");
    if (!docs.length) {
      list.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    list.innerHTML = docs
      .map((d) => {
        const isCur = current && current.id === d.id;
        const dirtyMark = isCur && dirty ? '<span class="dirty-dot" title="ذخیره‌نشده">●</span>' : "";
        const pinMark = d.is_pinned ? '<span class="pin" title="سنجاق‌شده">📌</span>' : "";
        return `<div class="st-doc${isCur ? " active" : ""}" data-id="${d.id}">
          <div class="st-doc-title">${pinMark}${dirtyMark}<span>${esc(d.title) || "بدون عنوان"}</span></div>
          <div class="st-doc-meta"><span>${TYPE_LABELS[d.document_type] || d.document_type}</span>${d.publish_state === "published" ? '<span class="st-pub-chip">منتشرشده</span>' : ""}<span>${faDate(d.updated_at)}</span><span>${faNum(d.word_count)} کلمه</span></div>
          ${isCur ? `<div class="st-doc-actions">
            <button data-op="rename">تغییرنام</button>
            <button data-op="pin">${d.is_pinned ? "برداشتن سنجاق" : "سنجاق"}</button>
            <button data-op="duplicate">تکثیر</button>
          </div>` : ""}
        </div>`;
      })
      .join("");
    list.querySelectorAll(".st-doc").forEach((el) => {
      const id = parseInt((el as HTMLElement).dataset.id || "0", 10);
      el.addEventListener("click", (ev) => {
        const btn = (ev.target as HTMLElement).closest("button[data-op]");
        if (btn) {
          ev.stopPropagation();
          void docAction(id, (btn as HTMLElement).dataset.op || "");
          return;
        }
        if (!current || current.id !== id) void openDoc(id);
      });
    });
  }

  async function docAction(id: number, op: string) {
    const d = docs.find((x) => x.id === id);
    if (!d) return;
    if (op === "rename") {
      const name = prompt("نام جدید سند:", d.title);
      if (name === null || !name.trim() || name.trim() === d.title) return;
      if (current && current.id === id) {
        ($("docTitle") as HTMLInputElement).value = name.trim();
        dirty = true;
        setSaveStatus("dirty");
        await saveDoc(false);
      } else {
        const full = await api(`/api/admin/documents/${id}`);
        await api(`/api/admin/documents/${id}`, {
          method: "PUT",
          body: { title: name.trim(), version: full.document.version },
        });
        await refreshList(false);
      }
    } else if (op === "pin") {
      if (current && current.id === id) {
        await api(`/api/admin/documents/${id}`, {
          method: "PUT",
          body: { is_pinned: !d.is_pinned, version: current.version },
        }).then((r: any) => {
          current!.version = r.version;
        });
      } else {
        const full = await api(`/api/admin/documents/${id}`);
        await api(`/api/admin/documents/${id}`, {
          method: "PUT",
          body: { is_pinned: !d.is_pinned, version: full.document.version },
        });
      }
      await refreshList(false);
    } else if (op === "duplicate") {
      const res = await api(`/api/admin/documents/${id}/duplicate`, { method: "POST" });
      toast("تکثیر شد.");
      await refreshList(true);
      await openDoc(res.id);
    }
  }

  async function openDoc(id: number) {
    if (current && dirty) {
      const ok = await saveDoc(false);
      if (!ok) {
        if (!confirm("ذخیره ناموفق بود. بدون ذخیره ادامه می‌دی؟ (متنت در حافظه‌ی موقت مرورگر می‌مونه)")) return;
      }
    }
    $("conflictBanner").hidden = true;
    const res = await api(`/api/admin/documents/${id}`);
    const doc: FullDoc = res.document;
    current = doc;
    localStorage.setItem("ahura-studio-last", String(id));
    ($("docTitle") as HTMLInputElement).value = doc.title;
    ($("metaType") as HTMLSelectElement).value = doc.document_type;
    ($("metaFolder") as HTMLSelectElement).value = doc.folder_id ? String(doc.folder_id) : "";
    ($("metaTags") as HTMLInputElement).value = doc.tags || "";
    ($("slugInput") as HTMLInputElement).value = doc.slug || "";
    ($("excerptInput") as HTMLTextAreaElement).value = doc.excerpt || "";
    updatePublishUI();
    ($("docInfo") as HTMLElement).innerHTML =
      `نسخه‌ی ${faNum(doc.version)} · ساخته‌شده: ${faDate(doc.created_at)}<br>آخرین تغییر: ${faDate(doc.updated_at)}`;
    ($("studioWelcome") as HTMLElement).hidden = true;
    ($("vditor") as HTMLElement).style.display = "";
    if (!vditor) {
      initEditor(doc.markdown_content);
    } else {
      vditor.setValue(doc.markdown_content);
    }
    dirty = false;
    setSaveStatus("idle");
    updateStats();
    renderDocList();
    checkRecovery(doc);
    void loadRevisions();
  }

  /* ---------------- publishing ---------------- */

  function updatePublishUI() {
    const badge = $("pubBadge") as HTMLElement;
    const hint = $("pubSyncHint") as HTMLElement;
    const btnP = $("btnPublish") as HTMLButtonElement;
    const btnU = $("btnUnpublish") as HTMLButtonElement;
    if (!current) {
      badge.textContent = "پیش‌نویس";
      badge.className = "st-badge st-badge-draft";
      hint.textContent = "";
      btnP.hidden = true;
      btnU.hidden = true;
      return;
    }
    const published = current.publish_state === "published";
    badge.textContent = published ? "منتشرشده" : "پیش‌نویس";
    badge.className = "st-badge " + (published ? "st-badge-pub" : "st-badge-draft");
    if (published) {
      hint.textContent =
        current.sync_state === "dirty"
          ? "تغییرات در انتظار همگام‌سازی با سایت است"
          : current.slug
            ? "همگام با سایت"
            : "";
    } else {
      hint.textContent = "";
    }
    const isArticle = current.document_type === "article";
    btnP.hidden = published;
    btnU.hidden = !published;
    btnP.disabled = !isArticle;
    btnP.title = isArticle ? "" : "برای انتشار، نوع سند را «مقاله» انتخاب کن";
    ($("publishSection") as HTMLElement).hidden = !current;
  }

  function validateForPublish(): { slug: string; excerpt: string } | null {
    if (!current) return null;
    if (current.document_type !== "article") {
      toast("فقط سندهای «مقاله» قابل انتشارند.", true);
      return null;
    }
    const slug = ($("slugInput") as HTMLInputElement).value.trim();
    if (!SLUG_RE.test(slug)) {
      toast("اسلاگ نامعتبر است — فقط حروف کوچک انگلیسی، عدد و خط‌تیره.", true);
      return null;
    }
    const excerpt = ($("excerptInput") as HTMLTextAreaElement).value.trim();
    if (!excerpt) {
      toast("توضیح کوتاه (متا) را وارد کن.", true);
      return null;
    }
    return { slug, excerpt };
  }

  async function publishCurrent() {
    if (!current || !vditor || !editorReady) return;
    const v = validateForPublish();
    if (!v) return;
    // Save first so the published copy is the current content.
    if (!(await saveDoc(false))) {
      toast("ابتدا ذخیره باید موفق باشد.", true);
      return;
    }
    if (!current) return;
    setSaveStatus("saving");
    try {
      const res = await api(`/api/admin/documents/${current.id}/publish`, {
        method: "POST",
        body: { slug: v.slug, excerpt: v.excerpt },
      });
      current.version = res.version;
      current.publish_state = "published";
      current.slug = res.slug;
      current.published_at = res.published_at;
      current.sync_state = "dirty";
      setSaveStatus("saved");
      updatePublishUI();
      void refreshList(false);
      toast("منتشر شد. برای رفتن روی سایت، همگام‌سازی لازم است — به من بگو انجامش بدم.");
    } catch (e: any) {
      setSaveStatus("idle");
      toast("انتشار ناموفق بود: " + (e.message || e), true);
    }
  }

  async function unpublishCurrent() {
    if (!current) return;
    if (!confirm("انتشار این سند لغو شود؟ (از سایت برداشته می‌شود)")) return;
    try {
      const res = await api(`/api/admin/documents/${current.id}/unpublish`, { method: "POST", body: {} });
      current.version = res.version;
      current.publish_state = "draft";
      current.sync_state = "dirty";
      updatePublishUI();
      void refreshList(false);
      toast("به پیش‌نویس برگشت.");
    } catch (e: any) {
      toast("لغو انتشار ناموفق بود: " + (e.message || e), true);
    }
  }

  function checkRecovery(doc: FullDoc) {
    const banner = $("recoveryBanner");
    banner.hidden = true;
    let stash: any = null;
    try {
      stash = JSON.parse(localStorage.getItem("ahura-studio-recovery-" + doc.id) || "null");
    } catch {
      /* noop */
    }
    if (stash && typeof stash.content === "string" && stash.content !== doc.markdown_content) {
      banner.hidden = false;
      banner.innerHTML =
        `<span>متن ذخیره‌نشده‌ای از ${faDate(new Date(stash.savedAt).toISOString())} پیدا شد.</span>` +
        `<button id="rcRestore">بازیابی</button><button id="rcDiscard">نادیده گرفتن</button>`;
      ($("rcRestore") as HTMLButtonElement).onclick = () => {
        if (vditor) vditor.setValue(stash.content);
        if (stash.title) ($("docTitle") as HTMLInputElement).value = stash.title;
        banner.hidden = true;
        dirty = true;
        setSaveStatus("dirty");
        updateStats();
        toast("متن بازیابی شد؛ با ذخیره‌ی بعدی دائمی می‌شه.");
      };
      ($("rcDiscard") as HTMLButtonElement).onclick = () => {
        clearRecovery(doc.id);
        banner.hidden = true;
      };
    }
  }

  async function newDoc() {
    const type = ($("filterType") as HTMLSelectElement).value || "note";
    const res = await api("/api/admin/documents", {
      method: "POST",
      body: { title: "سند بدون عنوان", document_type: type },
    });
    await refreshList(true);
    await openDoc(res.document.id);
    setTimeout(() => ($("docTitle") as HTMLInputElement).select(), 100);
  }

  /* ---------------- folders ---------------- */

  async function refreshFolders() {
    const res = await api("/api/admin/folders");
    folders = res.folders || [];
    const fl = $("folderList");
    const allActive = activeFolder === "all" ? " active" : "";
    fl.innerHTML =
      `<div class="st-folder${allActive}" data-f="all"><span>همه‌ی اسناد</span><span class="st-count">${faNum(docs.length)}</span></div>` +
      `<div class="st-folder${activeFolder === "none" ? " active" : ""}" data-f="none"><span>بدون پوشه</span></div>` +
      folders
        .map(
          (f) => `<div class="st-folder${activeFolder === f.id ? " active" : ""}" data-f="${f.id}">
            <span>📁 ${esc(f.name)}</span>
            <span><span class="st-count">${faNum(f.doc_count)}</span> <button class="st-mini-btn st-folder-del" data-del="${f.id}" title="حذف پوشه">×</button></span></div>`
        )
        .join("");
    fl.querySelectorAll(".st-folder-del").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void deleteFolder(parseInt((btn as HTMLElement).dataset.del || "0", 10));
      });
    });
    fl.querySelectorAll(".st-folder").forEach((el) => {
      el.addEventListener("click", () => {
        const v = (el as HTMLElement).dataset.f || "all";
        activeFolder = v === "all" ? "all" : v === "none" ? "none" : parseInt(v, 10);
        void refreshList(true);
        void refreshFolders();
      });
      el.addEventListener("dblclick", () => {
        const v = (el as HTMLElement).dataset.f || "";
        if (v !== "all" && v !== "none") void renameFolder(parseInt(v, 10));
      });
    });
    const mf = $("metaFolder") as HTMLSelectElement;
    const cur = mf.value;
    mf.innerHTML = `<option value="">بدون پوشه</option>` + folders.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join("");
    mf.value = cur;
  }

  async function renameFolder(id: number) {
    const f = folders.find((x) => x.id === id);
    if (!f) return;
    const name = prompt("نام جدید پوشه:", f.name);
    if (name === null || !name.trim() || name.trim() === f.name) return;
    await api(`/api/admin/folders/${id}`, { method: "PUT", body: { name: name.trim() } });
    await refreshFolders();
  }

  async function deleteFolder(id: number) {
    const f = folders.find((x) => x.id === id);
    if (!f) return;
    if (!confirm(`پوشه‌ی «${f.name}» حذف بشه؟ اسناد داخلش بی‌پوشه می‌شن (پاک نمی‌شن).`)) return;
    await api(`/api/admin/folders/${id}`, { method: "DELETE" });
    if (activeFolder === id) activeFolder = "all";
    toast("پوشه حذف شد.");
    await refreshFolders();
    await refreshList(true);
  }

  /* ---------------- stats ---------------- */

  function updateStats() {
    const value = vditor && editorReady ? vditor.getValue() : current?.markdown_content || "";
    const words = countWords(value);
    const chars = value.length;
    const charsNoSpace = value.replace(/\s/g, "").length;
    const paras = value.split(/\n\s*\n/).filter((p) => p.trim()).length;
    const headings = (value.match(/^#{1,6}\s+/gm) || []).length;
    const minutes = Math.max(1, Math.round(words / 200));
    ($("statWords") as HTMLElement).textContent = faNum(words);
    ($("statChars") as HTMLElement).textContent = faNum(chars);
    ($("statCharsNoSpace") as HTMLElement).textContent = faNum(charsNoSpace);
    ($("statParas") as HTMLElement).textContent = faNum(paras);
    ($("statHeadings") as HTMLElement).textContent = faNum(headings);
    ($("statReading") as HTMLElement).textContent = words ? `${faNum(minutes)} دقیقه` : "—";
  }

  /* ---------------- revisions ---------------- */

  async function loadRevisions() {
    if (!current) return;
    const res = await api(`/api/admin/documents/${current.id}/revisions`);
    const list = $("revisionList");
    const revs: Revision[] = res.revisions || [];
    if (!revs.length) {
      list.innerHTML = '<div class="st-empty-sub">نسخه‌ای ثبت نشده. ذخیره‌ی دستی نسخه می‌سازه.</div>';
      return;
    }
    list.innerHTML = revs
      .map(
        (r) => `<button class="st-rev" data-rev="${r.id}">
          <div>نسخه‌ی ${faNum(r.version)} ${r.reason === "manual" ? "· دستی" : ""}</div>
          <div class="st-rev-meta">${faDate(r.created_at)} · ${esc((r.preview || "").slice(0, 60))}...</div>
        </button>`
      )
      .join("");
    list.querySelectorAll(".st-rev").forEach((el) => {
      el.addEventListener("click", () => void showRevision(parseInt((el as HTMLElement).dataset.rev || "0", 10)));
    });
  }

  let viewingRev = 0;
  async function showRevision(revId: number) {
    if (!current) return;
    viewingRev = revId;
    const res = await api(`/api/admin/documents/${current.id}/revisions/${revId}`);
    const r = res.revision;
    ($("revisionMeta") as HTMLElement).textContent = `نسخه‌ی ${faNum(r.version)} · ${faDate(r.created_at)} · ${r.title}`;
    ($("revisionPreview") as HTMLElement).textContent = r.markdown_content;
    ($("revisionModal") as HTMLElement).hidden = false;
  }

  /* ---------------- import / export ---------------- */

  function downloadFile(name: string, content: string, mime: string) {
    const blob = new Blob([content], { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  function slugifyTitle(t: string): string {
    return (t || "document").trim().replace(/\s+/g, "-").slice(0, 60) || "document";
  }

  async function menuAction(act: string) {
    ($("moreMenu") as HTMLElement).hidden = true;
    if (!current || !vditor) {
      toast("اول یک سند رو باز کن.", true);
      return;
    }
    const value = vditor.getValue();
    const title = ($("docTitle") as HTMLInputElement).value.trim() || "document";
    if (act === "export-md") {
      downloadFile(slugifyTitle(title) + ".md", value, "text/markdown;charset=utf-8");
      toast("فایل Markdown دانلود شد.");
    } else if (act === "copy-md") {
      await navigator.clipboard.writeText(value);
      toast("سورس Markdown کپی شد.");
    } else if (act === "copy-html") {
      const html = await Vditor.md2html(value, { cdn: (import.meta.env.BASE_URL || "/") + "vditor-dist" });
      await navigator.clipboard.writeText(html);
      toast("HTML کپی شد.");
    } else if (act === "print") {
      const html = await Vditor.md2html(value, { cdn: (import.meta.env.BASE_URL || "/") + "vditor-dist" });
      const w = window.open("", "_blank");
      if (!w) {
        toast("پاپ‌آپ مسدود شد.", true);
        return;
      }
      w.document.write(`<!DOCTYPE html><html dir="rtl" lang="fa"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${html}</body></html>`);
      w.document.close();
      w.focus();
      setTimeout(() => w.print(), 800);
    } else if (act === "manual-save") {
      await saveDoc(true);
    }
  }

  function syncBackdrop() {
    const w = window.innerWidth;
    const studio = $("studio");
    const rightOpen = w <= 1100 && !studio.classList.contains("right-collapsed");
    const leftOpen = w <= 820 && !studio.classList.contains("left-collapsed");
    ($("studioBackdrop") as HTMLElement).hidden = !(rightOpen || leftOpen);
  }

  /* ---------------- wire up ---------------- */

  function wireEvents() {
    $("btnNewDoc").addEventListener("click", () => void newDoc());
    ($("btnWelcomeNew") as HTMLElement).addEventListener("click", () => void newDoc());
    $("btnImport").addEventListener("click", () => ($("importFile") as HTMLInputElement).click());
    ($("importFile") as HTMLInputElement).addEventListener("change", async (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files && input.files[0];
      input.value = "";
      if (!file) return;
      const text = await file.text();
      const title = file.name.replace(/\.(md|markdown|txt)$/i, "") || "سند واردشده";
      const res = await api("/api/admin/documents", {
        method: "POST",
        body: { title: title.slice(0, 300), document_type: "note", markdown_content: text.slice(0, 2000000) },
      });
      toast("سند وارد شد.");
      await refreshList(true);
      await openDoc(res.document.id);
    });

    ($("docSearch") as HTMLInputElement).addEventListener("input", (e) => {
      if (searchTimer) window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        searchQ = (e.target as HTMLInputElement).value.trim();
        void refreshList(true);
      }, 400);
    });
    ($("filterType") as HTMLSelectElement).addEventListener("change", () => void refreshList(true));
    ($("filterStatus") as HTMLSelectElement).addEventListener("change", () => void refreshList(true));

    $("btnNewFolder").addEventListener("click", async () => {
      const name = prompt("نام پوشه‌ی جدید:");
      if (!name || !name.trim()) return;
      await api("/api/admin/folders", { method: "POST", body: { name: name.trim() } });
      await refreshFolders();
    });

    ($("docTitle") as HTMLInputElement).addEventListener("input", () => {
      if (!current) return;
      dirty = true;
      setSaveStatus("dirty");
      if (saveTimer) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => void saveDoc(false), AUTOSAVE_MS);
    });
    ($("metaType") as HTMLSelectElement).addEventListener("change", () => {
      if (!current) return;
      dirty = true;
      setSaveStatus("dirty");
      void saveDoc(false);
    });
    ($("metaFolder") as HTMLSelectElement).addEventListener("change", () => {
      if (!current) return;
      dirty = true;
      setSaveStatus("dirty");
      void saveDoc(false);
      void refreshList(false);
    });
    ($("metaTags") as HTMLInputElement).addEventListener("change", () => {
      if (!current) return;
      dirty = true;
      setSaveStatus("dirty");
      void saveDoc(false);
    });
    ($("slugInput") as HTMLInputElement).addEventListener("change", () => {
      if (!current) return;
      dirty = true;
      setSaveStatus("dirty");
      void saveDoc(false);
    });
    ($("excerptInput") as HTMLTextAreaElement).addEventListener("change", () => {
      if (!current) return;
      dirty = true;
      setSaveStatus("dirty");
      void saveDoc(false);
    });
    ($("btnPublish") as HTMLButtonElement).addEventListener("click", () => void publishCurrent());
    ($("btnUnpublish") as HTMLButtonElement).addEventListener("click", () => void unpublishCurrent());
    ($("metaType") as HTMLSelectElement).addEventListener("change", () => updatePublishUI());

    document.querySelectorAll("#modeSwitcher button").forEach((b) => {
      b.addEventListener("click", () => void switchMode((b as HTMLElement).dataset.mode as any));
    });

    $("btnToggleLeft").addEventListener("click", () => {
      $("studio").classList.toggle("left-collapsed");
      syncBackdrop();
    });
    $("btnToggleRight").addEventListener("click", () => {
      $("studio").classList.toggle("right-collapsed");
      syncBackdrop();
    });
    $("btnCloseLeft").addEventListener("click", () => {
      $("studio").classList.add("left-collapsed");
      syncBackdrop();
    });
    $("btnCloseRight").addEventListener("click", () => {
      $("studio").classList.add("right-collapsed");
      syncBackdrop();
    });
    ($("studioBackdrop") as HTMLElement).addEventListener("click", () => {
      $("studio").classList.add("left-collapsed", "right-collapsed");
      syncBackdrop();
    });
    window.addEventListener("resize", syncBackdrop);
    $("btnFocus").addEventListener("click", () => {
      const on = $("studio").classList.toggle("focus");
      ($("btnFocus") as HTMLElement).classList.toggle("on", on);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && ($("moreMenu") as HTMLElement).hidden === false) {
        ($("moreMenu") as HTMLElement).hidden = true;
      }
    });

    $("btnMore").addEventListener("click", (e) => {
      e.stopPropagation();
      ($("moreMenu") as HTMLElement).hidden = !($("moreMenu") as HTMLElement).hidden;
    });
    document.addEventListener("click", (e) => {
      const wrap = document.querySelector(".st-menu-wrap");
      if (wrap && !wrap.contains(e.target as Node)) ($("moreMenu") as HTMLElement).hidden = true;
    });
    document.querySelectorAll("#moreMenu button").forEach((b) => {
      b.addEventListener("click", () => void menuAction((b as HTMLElement).dataset.act || ""));
    });

    $("btnPin").addEventListener("click", () => {
      if (current) void docAction(current.id, "pin");
    });
    $("btnDuplicate").addEventListener("click", () => {
      if (current) void docAction(current.id, "duplicate");
    });
    $("btnArchive").addEventListener("click", async () => {
      if (!current) return;
      if (current.status === "archived") {
        await api(`/api/admin/documents/${current.id}/restore`, { method: "POST" });
        toast("از بایگانی برگشت.");
      } else {
        if (dirty) await saveDoc(false);
        await api(`/api/admin/documents/${current.id}/archive`, { method: "POST" });
        toast("بایگانی شد.");
      }
      current = null;
      if (vditor) vditor.setValue("");
      ($("studioWelcome") as HTMLElement).hidden = false;
      await refreshList(true);
    });
    $("btnTrash").addEventListener("click", async () => {
      if (!current) return;
      const inTrash = current.status === "trashed";
      if (!confirm(inTrash ? "این سند برای همیشه حذف بشه؟ این عمل برگشت‌ناپذیره." : "این سند به سطل زباله منتقل بشه؟")) return;
      if (inTrash) {
        await api(`/api/admin/documents/${current.id}?permanent=1`, { method: "DELETE" });
        toast("برای همیشه حذف شد.");
      } else {
        if (dirty) await saveDoc(false);
        await api(`/api/admin/documents/${current.id}`, { method: "DELETE" });
        toast("به سطل زباله منتقل شد.");
      }
      clearRecovery(current.id);
      current = null;
      if (vditor) vditor.setValue("");
      ($("studioWelcome") as HTMLElement).hidden = false;
      await refreshList(true);
    });

    ($("revisionClose") as HTMLElement).addEventListener("click", () => {
      ($("revisionModal") as HTMLElement).hidden = true;
    });
    ($("revisionRestore") as HTMLElement).addEventListener("click", async () => {
      if (!current || !viewingRev) return;
      if (!confirm("این نسخه بازیابی بشه؟ محتوای فعلی به‌عنوان نسخه‌ی جدید ذخیره می‌شه.")) return;
      await api(`/api/admin/documents/${current.id}/revisions/${viewingRev}/restore`, { method: "POST" });
      ($("revisionModal") as HTMLElement).hidden = true;
      toast("نسخه بازیابی شد.");
      await openDoc(current.id);
    });

    window.addEventListener("beforeunload", (e) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    });

    if (window.innerWidth <= 820) $("studio").classList.add("left-collapsed");
    if (window.innerWidth <= 1100) $("studio").classList.add("right-collapsed");
    syncBackdrop();
  }

  /* ---------------- boot ---------------- */

  async function boot() {
    token = sessionStorage.getItem("ahura-admin-token") || "";
    try {
      await A().ready;
    } catch {
      return;
    }
    token = sessionStorage.getItem("ahura-admin-token") || "";
    ($("studio") as HTMLElement).hidden = false;
    syncModeButtons();
    wireEvents();
    try {
      await refreshFolders();
      await refreshList(false);
      const fromUrl = new URLSearchParams(location.search).get("doc");
      const wanted = fromUrl && /^\d+$/.test(fromUrl) ? parseInt(fromUrl, 10) : null;
      const last = localStorage.getItem("ahura-studio-last");
      const target =
        (wanted && docs.some((d) => d.id === wanted) ? wanted : null) ??
        (last && docs.some((d) => d.id === parseInt(last, 10)) ? parseInt(last, 10) : docs[0]?.id);
      if (target) {
        await openDoc(target);
      } else {
        ($("studioWelcome") as HTMLElement).hidden = false;
        ($("vditor") as HTMLElement).style.display = "none";
      }
    } catch (e: any) {
      if (e.message !== "unauthorized") toast("خطا در بارگذاری: " + e.message, true);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    void boot();
  }
}
