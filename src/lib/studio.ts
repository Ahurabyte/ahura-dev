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
interface FolderTotals {
  all: number;
  unfiled: number;
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
      errMsg: (e: any) => string;
      confirm: (msg: string, o?: { danger?: boolean; okText?: string; cancelText?: string }) => Promise<boolean>;
      prompt: (msg: string, def?: string, o?: { okText?: string; maxLength?: number }) => Promise<string | null>;
      copyText: (t: string) => Promise<boolean>;
      isDark: () => boolean;
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
const PER_PAGE = 50;
/* D1 rows are capped at ~2 MB; the Worker stores images as base64 (+33%). */
const MAX_UPLOAD_BYTES = 1_400_000;
const MAX_DOC_BYTES = 1_500_000;
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

/* localStorage can throw (private mode, quota, blocked): never let that break the studio. */
const lsGet = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* noop */
  }
};
const lsDel = (k: string) => {
  try {
    localStorage.removeItem(k);
  } catch {
    /* noop */
  }
};
const byteLen = (s: string) => new TextEncoder().encode(s).length;
const cdnBase = () => (import.meta.env.BASE_URL || "/").replace(/\/?$/, "/") + "vditor-dist";

/* Shrinks big photos in the browser (max 1920px, WebP) so they fit the Worker's
 * per-image limit. GIFs are left alone (animation); any failure falls back to the
 * original file and the server then reports a clear "too large" error. */
async function compressImage(file: File): Promise<File> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size <= 700_000) return file;
  try {
    const bmp = await createImageBitmap(file);
    const tries: Array<[number, number]> = [[1920, 0.86], [1600, 0.78], [1280, 0.7]];
    for (const [maxSide, q] of tries) {
      const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(bmp.width * scale));
      c.height = Math.max(1, Math.round(bmp.height * scale));
      c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
      const blob: Blob | null = await new Promise((r) => c.toBlob(r, "image/webp", q));
      if (!blob || blob.type !== "image/webp") break; // browser can't encode WebP
      if (blob.size <= MAX_UPLOAD_BYTES) {
        const out = new File([blob], file.name.replace(/\.[^.]+$/, "") + ".webp", { type: "image/webp" });
        return out.size < file.size ? out : file;
      }
    }
  } catch {
    /* fall through */
  }
  return file;
}

function countWords(t: string): number {
  const m = (t || "").match(/[\p{L}\p{N}]+/gu);
  return m ? m.length : 0;
}

export function initStudio() {
  let vditor: Vditor | null = null;
  let editorReady = false;
  let readyP: Promise<void> = Promise.resolve();
  let readyResolve: () => void = () => {};
  let docs: DocMeta[] = [];
  let docsTotal = 0;
  let listPage = 1;
  let folders: Folder[] = [];
  let folderTotals: FolderTotals = { all: 0, unfiled: 0 };
  let current: FullDoc | null = null;
  let dirty = false;
  /* editSeq counts every user edit. A save only clears `dirty` if no edit happened
   * while its request was in flight (the old code cleared it unconditionally, so
   * text typed during a save was never saved until the NEXT keystroke). */
  let editSeq = 0;
  let inflight: Promise<boolean> | null = null;
  let openSeq = 0;
  let listSeq = 0;
  let saveTimer: number | null = null;
  let stashTimer: number | null = null;
  let mode: "wysiwyg" | "ir" | "sv" = (lsGet("ahura-studio-mode") as any) || "ir";
  if (!["wysiwyg", "ir", "sv"].includes(mode)) mode = "ir";
  let activeFolder: number | "all" | "none" = "all";
  let searchQ = "";
  let searchTimer: number | null = null;

  const A = () => window.AdminAPI;
  const api = (path: string, opts?: any) => A().api(path, opts);
  const esc = (s: any) => A().esc(s);
  const toast = (m: string, e?: boolean) => A().toast(m, e);
  const errText = (e: any) => A().errMsg(e);
  const isDark = () => A().isDark();
  const token = () => {
    try {
      return sessionStorage.getItem("ahura-admin-token") || "";
    } catch {
      return "";
    }
  };
  const el = <T extends HTMLElement = HTMLElement>(id: string) => $(id) as T;
  /* Event handlers must never fail silently: surface API errors as a toast. */
  const safe =
    <Args extends any[]>(fn: (...a: Args) => Promise<any>) =>
    (...a: Args) => {
      fn(...a).catch((e: any) => {
        if (e && e.message === "unauthorized") return;
        toast(errText(e), true);
      });
    };

  /* ---------------- Vditor lifecycle ---------------- */

  function vditorOptions(value: string): any {
    const dark = isDark();
    const compact = window.innerWidth <= 820;
    const full = [
      "emoji", "headings", "bold", "italic", "strike", "link", "|",
      "list", "ordered-list", "check", "outdent", "indent", "|",
      "quote", "line", "code", "inline-code", "insert-before", "insert-after", "|",
      "upload", "table", "|",
      "undo", "redo", "|",
      "outline", "preview", "fullscreen", "code-theme", "content-theme", "info",
    ];
    // Phones: a 30-icon toolbar wraps into 4+ rows and eats the screen. Keep the
    // essentials and tuck the rest behind a "more" button.
    const small: any[] = [
      "headings", "bold", "italic", "link", "|",
      "list", "ordered-list", "check", "|",
      "quote", "code", "upload", "|",
      "undo", "redo",
      {
        name: "more",
        toolbar: [
          "emoji", "strike", "inline-code", "line", "table", "outdent", "indent",
          "insert-before", "insert-after", "preview", "fullscreen", "code-theme", "content-theme", "info",
        ],
      },
    ];
    return {
      cdn: cdnBase(),
      lang: "en_US",
      mode,
      value,
      theme: dark ? "dark" : "classic",
      cache: { enable: false },
      counter: { enable: false },
      // the outline sidebar is 200px wide: only worth it on big screens
      outline: { enable: window.innerWidth > 1280, position: "right" },
      toolbarConfig: { pin: true },
      preview: {
        mode: compact ? "editor" : "both",
        theme: { current: dark ? "dark" : "light" },
        hljs: { enable: true, style: dark ? "github-dark" : "github", lineNumber: true },
        math: { engine: "KaTeX" },
        markdown: { toc: true, footnotes: true },
      },
      upload: {
        url: A().API + "/api/admin/upload",
        fieldName: "file[]",
        max: MAX_UPLOAD_BYTES,
        accept: "image/png,image/jpeg,image/webp,image/gif",
        multiple: true,
        filename: (name: string) => name,
        file: (files: File[]) => Promise.all(files.map(compressImage)),
        setHeaders: () => ({ Authorization: "Bearer " + token() }),
        format: (files: File[], responseText: string) => {
          try {
            const data = JSON.parse(responseText);
            if (data && data.success === false) throw new Error(data.error || "upload_failed");
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
        error: (msg: string) => {
          let text = msg;
          try {
            const j = JSON.parse(msg);
            if (j && j.error) text = errText({ code: j.error });
          } catch {
            /* raw message */
          }
          toast("خطا در آپلود عکس: " + text, true);
        },
      },
      toolbar: compact ? small : full,
      after: () => {
        editorReady = true;
        readyResolve();
        updateStats();
      },
      input: () => {
        if (!current) return;
        onEdit();
      },
      blur: () => {
        if (dirty && current) void saveDoc(false);
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
    readyP = new Promise<void>((r) => (readyResolve = r));
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
      lsSet("ahura-studio-mode", mode);
      syncModeButtons();
      return;
    }
    await readyP;
    const value = vditor.getValue();
    mode = next;
    lsSet("ahura-studio-mode", mode);
    initEditor(value);
    toast("حالت ویرایش تغییر کرد.");
  }

  function applyTheme() {
    if (!vditor || !editorReady) return;
    const dark = isDark();
    try {
      vditor.setTheme(dark ? "dark" : "classic", dark ? "dark" : "light", dark ? "github-dark" : "github");
    } catch {
      /* noop */
    }
  }

  /* ---------------- save / autosave ---------------- */

  function setSaveStatus(state: "idle" | "dirty" | "saving" | "saved" | "error", text?: string) {
    const s = el("saveStatus");
    s.className = "st-save-status" + (state === "saving" ? " saving" : state === "saved" ? " saved" : state === "error" ? " error" : "");
    s.textContent =
      text ||
      (state === "dirty" ? "● ذخیره‌نشده" : state === "saving" ? "در حال ذخیره..." : state === "saved" ? "✓ ذخیره شد" : state === "error" ? "✕ خطا در ذخیره" : "");
  }

  function stashRecovery() {
    if (!current || !vditor || !editorReady) return;
    lsSet(
      "ahura-studio-recovery-" + current.id,
      JSON.stringify({ content: vditor.getValue(), title: el<HTMLInputElement>("docTitle").value, savedAt: Date.now() })
    );
  }

  const clearRecovery = (id: number) => lsDel("ahura-studio-recovery-" + id);

  function scheduleSave(ms = AUTOSAVE_MS) {
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void saveDoc(false), ms);
  }

  /* Every user change (body, title, metadata) goes through here. */
  function markDirty() {
    if (!current) return;
    editSeq++;
    dirty = true;
    setSaveStatus("dirty");
    scheduleSave();
  }

  function onEdit() {
    markDirty();
    updateStats();
    if (stashTimer) window.clearTimeout(stashTimer);
    stashTimer = window.setTimeout(stashRecovery, 1000);
  }

  /* Waits for any save in flight; callers then see the up-to-date version. */
  async function flushSave() {
    while (inflight) {
      try {
        await inflight;
      } catch {
        /* handled by the saver */
      }
    }
  }

  async function saveDoc(manual: boolean): Promise<boolean> {
    // The old code returned false when a save was already running, which made
    // "switch document" report a failed save. Now we just wait our turn.
    await flushSave();
    if (!current || !vditor || !editorReady) return false;
    if (!dirty && !manual) return true;
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    const run = doSave(manual);
    inflight = run;
    try {
      return await run;
    } finally {
      if (inflight === run) inflight = null;
    }
  }

  async function doSave(manual: boolean): Promise<boolean> {
    const doc = current!;
    const ed = vditor!;
    const seqAtStart = editSeq;
    const content = ed.getValue();
    if (byteLen(content) > MAX_DOC_BYTES) {
      setSaveStatus("error", "✕ متن بیش از حد بزرگ");
      toast("حجم متن از حد مجاز (حدود ۱٫۵ مگابایت) بیشتره؛ سند رو به چند بخش تقسیم کن.", true);
      return false;
    }
    setSaveStatus("saving");
    const folderVal = el<HTMLSelectElement>("metaFolder").value;
    const payload: Record<string, any> = {
      title: el<HTMLInputElement>("docTitle").value.trim() || "Untitled",
      markdown_content: content,
      document_type: el<HTMLSelectElement>("metaType").value,
      folder_id: folderVal ? parseInt(folderVal, 10) : null,
      tags: el<HTMLInputElement>("metaTags").value,
      excerpt: el<HTMLTextAreaElement>("excerptInput").value,
      version: doc.version,
      manual,
    };
    // Slug: only send when empty or a valid URL segment, so a half-typed
    // slug can never break autosave; publish validates strictly server-side.
    const slugRaw = el<HTMLInputElement>("slugInput").value.trim();
    if (slugRaw === "" || SLUG_RE.test(slugRaw)) payload.slug = slugRaw || null;
    try {
      const res = await api(`/api/admin/documents/${doc.id}`, { method: "PUT", body: payload });
      doc.version = res.version;
      doc.title = payload.title;
      doc.document_type = payload.document_type;
      doc.folder_id = payload.folder_id;
      doc.tags = payload.tags;
      doc.updated_at = res.updated_at;
      doc.markdown_content = payload.markdown_content;
      if ("slug" in payload) doc.slug = payload.slug;
      doc.excerpt = payload.excerpt;
      // Mirroring the server: edits on a published document stale its git copy.
      if (doc.publish_state === "published") doc.sync_state = "dirty";
      if (current === doc) {
        updatePublishUI();
        if (editSeq === seqAtStart) {
          dirty = false;
          clearRecovery(doc.id);
          setSaveStatus("saved");
          window.setTimeout(() => {
            if (!dirty) setSaveStatus("idle");
          }, 2500);
        } else {
          // typed while the request was running: keep the flag, save again soon
          setSaveStatus("dirty");
          scheduleSave(600);
        }
      }
      patchListEntry(doc);
      if (manual) {
        toast("ذخیره شد و نسخه ثبت شد.");
        void loadRevisions();
      }
      return true;
    } catch (e: any) {
      if (e.code === "version_conflict") {
        showConflict(e.current_version);
        setSaveStatus("error", "✕ تداخل نسخه");
      } else if (e.message === "unauthorized") {
        setSaveStatus("error", "✕ نیاز به ورود");
      } else if (e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 408) {
        // a rejected request will be rejected again: don't loop, say why
        setSaveStatus("error");
        toast("ذخیره ممکن نیست: " + errText(e), true);
      } else {
        setSaveStatus("error");
        toast("ذخیره ناموفق بود؛ متنت محفوظه، دوباره تلاش می‌شه.", true);
        scheduleSave(15000);
      }
      return false;
    }
  }

  function showConflict(serverVersion?: number) {
    const b = el("conflictBanner");
    b.hidden = false;
    const ver = serverVersion !== undefined ? ` (نسخه‌ی سرور: ${faNum(serverVersion)})` : "";
    b.innerHTML =
      `<span>این سند در جای دیگری تغییر کرده${ver}. متن فعلی تو محفوظه.</span>` +
      `<button id="cfLoad">بارگذاری نسخه‌ی سرور</button>` +
      `<button id="cfCopy">ذخیره‌ی متن من به‌عنوان سند جدید</button>` +
      `<button id="cfDismiss">بستن</button>`;
    el("cfLoad").onclick = safe(async () => {
      if (!(await A().confirm("متن فعلی‌ات با نسخه‌ی سرور جایگزین می‌شه. مطمئنی؟", { danger: true, okText: "جایگزین کن" }))) return;
      b.hidden = true;
      if (current) {
        clearRecovery(current.id);
        await openDoc(current.id, true);
      }
    });
    el("cfCopy").onclick = safe(async () => {
      if (!current || !vditor) return;
      const content = vditor.getValue();
      const title = el<HTMLInputElement>("docTitle").value.trim() || "Untitled";
      const res = await api("/api/admin/documents", {
        method: "POST",
        body: { title: title + " (کپی)", document_type: current.document_type, markdown_content: content },
      });
      b.hidden = true;
      toast("به‌عنوان سند جدید ذخیره شد.");
      await refreshList(true);
      await openDoc(res.document.id, true);
    });
    el("cfDismiss").onclick = () => {
      b.hidden = true;
    };
  }

  /* ---------------- document list ---------------- */

  /* append=true loads the next page (the list used to stop at 100 documents). */
  async function refreshList(resetScroll: boolean, append = false) {
    const mine = ++listSeq;
    const status = el<HTMLSelectElement>("filterStatus").value || "active";
    const type = el<HTMLSelectElement>("filterType").value;
    const page = append ? listPage + 1 : 1;
    const params = new URLSearchParams({
      status,
      per_page: String(PER_PAGE),
      page: String(page),
      sort: el<HTMLSelectElement>("filterSort").value || "updated",
    });
    if (type) params.set("type", type);
    if (activeFolder !== "all") params.set("folder_id", String(activeFolder));
    if (searchQ) params.set("q", searchQ);
    const res = await api("/api/admin/documents?" + params.toString());
    if (mine !== listSeq) return; // a newer request superseded this one
    listPage = page;
    docsTotal = res.total || 0;
    docs = append ? docs.concat(res.documents || []) : res.documents || [];
    renderDocList();
    if (resetScroll) el("docList").scrollTop = 0;
  }

  /* Autosave touches the list every few seconds: patch the one row in place instead of
   * refetching page 1 (which also threw away any "load more" pages). */
  function patchListEntry(d: FullDoc) {
    const row = docs.find((x) => x.id === d.id);
    if (!row) return;
    Object.assign(row, {
      title: d.title,
      document_type: d.document_type,
      folder_id: d.folder_id,
      tags: d.tags,
      updated_at: d.updated_at,
      publish_state: d.publish_state,
      slug: d.slug,
      sync_state: d.sync_state,
      is_pinned: d.is_pinned,
      version: d.version,
      word_count: countWords(d.markdown_content),
    });
    renderDocList();
  }

  const listError = (e: any) => {
    if (e && e.message === "unauthorized") return;
    toast(errText(e), true);
  };

  function renderDocList() {
    const list = el("docList");
    const empty = el("docListEmpty");
    el<HTMLButtonElement>("btnLoadMore").hidden = docs.length >= docsTotal;
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
          <div class="st-doc-meta"><span>${TYPE_LABELS[d.document_type] || esc(d.document_type)}</span>${d.publish_state === "published" ? '<span class="st-pub-chip">منتشرشده</span>' : ""}<span>${faDate(d.updated_at)}</span><span>${faNum(d.word_count)} کلمه</span></div>
          ${isCur ? `<div class="st-doc-actions">
            <button data-op="rename">تغییرنام</button>
            <button data-op="pin">${d.is_pinned ? "برداشتن سنجاق" : "سنجاق"}</button>
            <button data-op="duplicate">تکثیر</button>
          </div>` : ""}
        </div>`;
      })
      .join("");
    list.querySelectorAll(".st-doc").forEach((node) => {
      const id = parseInt((node as HTMLElement).dataset.id || "0", 10);
      node.addEventListener("click", (ev) => {
        const btn = (ev.target as HTMLElement).closest("button[data-op]");
        if (btn) {
          ev.stopPropagation();
          safe(docAction)(id, (btn as HTMLElement).dataset.op || "");
          return;
        }
        if (!current || current.id !== id) {
          closeDrawersOnMobile(); // otherwise the list drawer keeps covering the editor
          safe(openDoc)(id);
        } else {
          closeDrawersOnMobile();
        }
      });
    });
  }

  async function docAction(id: number, op: string) {
    const d = docs.find((x) => x.id === id);
    if (!d) return;
    const isCur = !!current && current.id === id;
    if (op === "rename") {
      const name = await A().prompt("نام جدید سند:", d.title, { maxLength: 300 });
      if (name === null || !name.trim() || name.trim() === d.title) return;
      if (isCur) {
        el<HTMLInputElement>("docTitle").value = name.trim();
        markDirty();
        await saveDoc(false);
      } else {
        const full = await api(`/api/admin/documents/${id}`);
        await api(`/api/admin/documents/${id}`, { method: "PUT", body: { title: name.trim(), version: full.document.version } });
        await refreshList(false);
      }
    } else if (op === "pin") {
      const next = !d.is_pinned;
      if (isCur) {
        await flushSave(); // never PUT with a version that an autosave is about to bump
        const r = await api(`/api/admin/documents/${id}`, { method: "PUT", body: { is_pinned: next, version: current!.version } });
        current!.version = r.version;
        current!.is_pinned = next;
        updateActionButtons();
      } else {
        const full = await api(`/api/admin/documents/${id}`);
        await api(`/api/admin/documents/${id}`, { method: "PUT", body: { is_pinned: next, version: full.document.version } });
      }
      await refreshList(false);
    } else if (op === "duplicate") {
      if (isCur && dirty) await saveDoc(false); // duplicate what's on screen, not the last save
      const res = await api(`/api/admin/documents/${id}/duplicate`, { method: "POST" });
      toast("تکثیر شد.");
      await refreshList(true);
      void refreshFolders();
      await openDoc(res.id, true);
    }
  }

  function showEditor(show: boolean) {
    el("vditor").hidden = !show;
    el("studioWelcome").hidden = show;
  }

  /* Back to the "pick a document" state without leaving stale panels behind. */
  function closeDoc() {
    openSeq++;
    if (saveTimer) window.clearTimeout(saveTimer);
    if (stashTimer) window.clearTimeout(stashTimer);
    current = null;
    dirty = false;
    setSaveStatus("idle");
    el<HTMLInputElement>("docTitle").value = "";
    el("conflictBanner").hidden = true;
    el("recoveryBanner").hidden = true;
    el("docInfo").innerHTML = "";
    el("revisionList").innerHTML = '<div class="st-empty-sub">نسخه‌ای ثبت نشده.</div>';
    el<HTMLInputElement>("slugInput").value = "";
    el<HTMLTextAreaElement>("excerptInput").value = "";
    el<HTMLInputElement>("metaTags").value = "";
    updatePublishUI();
    updateActionButtons();
    updateStats();
    showEditor(false);
    renderDocList();
  }

  async function openDoc(id: number, force = false) {
    const mine = ++openSeq;
    if (!force && current && dirty) {
      const ok = await saveDoc(false);
      if (!ok && !(await A().confirm("ذخیره ناموفق بود. بدون ذخیره ادامه می‌دی؟ (متنت در حافظه‌ی موقت مرورگر می‌مونه)", { danger: true, okText: "ادامه بدون ذخیره" }))) return;
    }
    if (mine !== openSeq) return;
    const res = await api(`/api/admin/documents/${id}`);
    if (mine !== openSeq) return; // user clicked another document meanwhile
    const doc: FullDoc = res.document;
    if (saveTimer) window.clearTimeout(saveTimer);
    if (stashTimer) window.clearTimeout(stashTimer);
    el("conflictBanner").hidden = true;
    current = doc;
    lsSet("ahura-studio-last", String(id));
    el<HTMLInputElement>("docTitle").value = doc.title;
    el<HTMLSelectElement>("metaType").value = doc.document_type;
    el<HTMLSelectElement>("metaFolder").value = doc.folder_id ? String(doc.folder_id) : "";
    el<HTMLInputElement>("metaTags").value = doc.tags || "";
    el<HTMLInputElement>("slugInput").value = doc.slug || "";
    el<HTMLTextAreaElement>("excerptInput").value = doc.excerpt || "";
    updatePublishUI();
    updateActionButtons();
    el("docInfo").innerHTML = `نسخه‌ی ${faNum(doc.version)} · ساخته‌شده: ${faDate(doc.created_at)}<br>آخرین تغییر: ${faDate(doc.updated_at)}`;
    showEditor(true);
    if (!vditor) {
      initEditor(doc.markdown_content);
    } else {
      await readyP;
      if (mine !== openSeq) return;
      // clearStack=true: otherwise Ctrl+Z walks back into the PREVIOUS document's
      // text, and the autosave then writes that text into this one.
      vditor.setValue(doc.markdown_content, true);
    }
    dirty = false;
    setSaveStatus("idle");
    updateStats();
    renderDocList();
    checkRecovery(doc);
    void loadRevisions();
  }

  /* Labels/enabled state of the right-panel buttons follow the document's status. */
  function updateActionButtons() {
    const st = current ? current.status : "active";
    el("btnArchive").textContent = st === "archived" ? "برگردان از بایگانی" : st === "trashed" ? "بازیابی" : "بایگانی";
    el("btnTrash").textContent = st === "trashed" ? "حذف دائمی" : "حذف";
    el("btnPin").textContent = current && current.is_pinned ? "برداشتن سنجاق" : "سنجاق";
    ["btnPin", "btnDuplicate", "btnArchive", "btnTrash"].forEach((id) => {
      el<HTMLButtonElement>(id).disabled = !current;
    });
  }

  /* ---------------- publishing ---------------- */

  function updatePublishUI() {
    const section = el("publishSection");
    const badge = el("pubBadge");
    const hint = el("pubSyncHint");
    const btnP = el<HTMLButtonElement>("btnPublish");
    const btnU = el<HTMLButtonElement>("btnUnpublish");
    if (!current) {
      section.hidden = true; // (it used to stay visible after the document was closed)
      badge.textContent = "پیش‌نویس";
      badge.className = "st-badge st-badge-draft";
      hint.textContent = "";
      btnP.hidden = true;
      btnU.hidden = true;
      return;
    }
    section.hidden = false;
    const published = current.publish_state === "published";
    badge.textContent = published ? "منتشرشده" : "پیش‌نویس";
    badge.className = "st-badge " + (published ? "st-badge-pub" : "st-badge-draft");
    hint.textContent = published
      ? current.sync_state === "dirty"
        ? "تغییرات در انتظار همگام‌سازی با سایت است"
        : current.slug
          ? "همگام با سایت"
          : ""
      : "";
    const isArticle = el<HTMLSelectElement>("metaType").value === "article";
    const active = current.status === "active";
    btnP.hidden = published;
    btnU.hidden = !published;
    btnP.disabled = !isArticle || !active;
    btnP.title = !active ? "فقط سند فعال قابل انتشاره" : isArticle ? "" : "برای انتشار، نوع سند را «مقاله» انتخاب کن";
  }

  function validateForPublish(): { slug: string; excerpt: string } | null {
    if (!current) return null;
    if (el<HTMLSelectElement>("metaType").value !== "article") {
      toast("فقط سندهای «مقاله» قابل انتشارند.", true);
      return null;
    }
    const slug = el<HTMLInputElement>("slugInput").value.trim();
    if (!SLUG_RE.test(slug)) {
      toast("اسلاگ نامعتبر است — فقط حروف کوچک انگلیسی، عدد و خط‌تیره.", true);
      return null;
    }
    const excerpt = el<HTMLTextAreaElement>("excerptInput").value.trim();
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
    if (!(await saveDoc(true))) {
      toast("ابتدا ذخیره باید موفق باشد.", true);
      return;
    }
    if (!current) return;
    setSaveStatus("saving");
    try {
      const res = await api(`/api/admin/documents/${current.id}/publish`, { method: "POST", body: { slug: v.slug, excerpt: v.excerpt } });
      current.version = res.version;
      current.publish_state = "published";
      current.slug = res.slug;
      current.published_at = res.published_at;
      current.sync_state = "dirty";
      setSaveStatus("saved");
      updatePublishUI();
      patchListEntry(current);
      toast("منتشر شد. برای رفتن روی سایت، همگام‌سازی لازم است — به من بگو انجامش بدم.");
    } catch (e: any) {
      setSaveStatus("idle");
      toast("انتشار ناموفق بود: " + errText(e), true);
    }
  }

  async function unpublishCurrent() {
    if (!current) return;
    if (!(await A().confirm("انتشار این سند لغو بشه؟ از سایت برداشته می‌شه.", { okText: "لغو انتشار" }))) return;
    await flushSave();
    try {
      const res = await api(`/api/admin/documents/${current.id}/unpublish`, { method: "POST", body: {} });
      current.version = res.version;
      current.publish_state = "draft";
      current.sync_state = "dirty";
      updatePublishUI();
      patchListEntry(current);
      toast("به پیش‌نویس برگشت.");
    } catch (e: any) {
      toast("لغو انتشار ناموفق بود: " + errText(e), true);
    }
  }

  function checkRecovery(doc: FullDoc) {
    const banner = el("recoveryBanner");
    banner.hidden = true;
    let stash: any = null;
    try {
      stash = JSON.parse(lsGet("ahura-studio-recovery-" + doc.id) || "null");
    } catch {
      /* noop */
    }
    if (stash && typeof stash.content === "string" && stash.content !== doc.markdown_content) {
      banner.hidden = false;
      banner.innerHTML =
        `<span>متن ذخیره‌نشده‌ای از ${faDate(new Date(stash.savedAt).toISOString())} پیدا شد.</span>` +
        `<button id="rcRestore">بازیابی</button><button id="rcDiscard">نادیده گرفتن</button>`;
      el("rcRestore").onclick = () => {
        if (vditor) vditor.setValue(stash.content);
        if (stash.title) el<HTMLInputElement>("docTitle").value = stash.title;
        banner.hidden = true;
        markDirty();
        updateStats();
        toast("متن بازیابی شد؛ با ذخیره‌ی بعدی دائمی می‌شه.");
      };
      el("rcDiscard").onclick = () => {
        clearRecovery(doc.id);
        banner.hidden = true;
      };
    }
  }

  async function newDoc() {
    const type = el<HTMLSelectElement>("filterType").value || "note";
    const body: Record<string, any> = { title: "سند بدون عنوان", document_type: type };
    if (typeof activeFolder === "number") body.folder_id = activeFolder; // create it where the user is looking
    const res = await api("/api/admin/documents", { method: "POST", body });
    // a new document must be visible: reset filters that would hide it
    if (el<HTMLSelectElement>("filterStatus").value !== "active") el<HTMLSelectElement>("filterStatus").value = "active";
    if (searchQ) {
      searchQ = "";
      el<HTMLInputElement>("docSearch").value = "";
    }
    await refreshList(true);
    void refreshFolders();
    closeDrawersOnMobile();
    await openDoc(res.document.id);
    setTimeout(() => el<HTMLInputElement>("docTitle").select(), 100);
  }

  /* ---------------- folders ---------------- */

  async function refreshFolders() {
    const res = await api("/api/admin/folders");
    folders = res.folders || [];
    folderTotals = res.totals || { all: 0, unfiled: 0 };
    const fl = el("folderList");
    fl.innerHTML =
      `<div class="st-folder${activeFolder === "all" ? " active" : ""}" data-f="all"><span>همه‌ی اسناد</span><span class="st-count">${faNum(folderTotals.all)}</span></div>` +
      `<div class="st-folder${activeFolder === "none" ? " active" : ""}" data-f="none"><span>بدون پوشه</span><span class="st-count">${faNum(folderTotals.unfiled)}</span></div>` +
      folders
        .map(
          (f) => `<div class="st-folder${activeFolder === f.id ? " active" : ""}" data-f="${f.id}">
            <span>📁 ${esc(f.name)}</span>
            <span><span class="st-count">${faNum(f.doc_count)}</span> <button class="st-mini-btn st-folder-del" data-del="${f.id}" title="حذف پوشه" aria-label="حذف پوشه">×</button></span></div>`
        )
        .join("");
    fl.querySelectorAll(".st-folder-del").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        safe(deleteFolder)(parseInt((btn as HTMLElement).dataset.del || "0", 10));
      });
    });
    fl.querySelectorAll(".st-folder").forEach((node) => {
      node.addEventListener("click", () => {
        const v = (node as HTMLElement).dataset.f || "all";
        activeFolder = v === "all" ? "all" : v === "none" ? "none" : parseInt(v, 10);
        refreshList(true).catch(listError);
        void refreshFolders();
      });
      node.addEventListener("dblclick", () => {
        const v = (node as HTMLElement).dataset.f || "";
        if (v !== "all" && v !== "none") safe(renameFolder)(parseInt(v, 10));
      });
    });
    const mf = el<HTMLSelectElement>("metaFolder");
    const cur = mf.value;
    mf.innerHTML = `<option value="">بدون پوشه</option>` + folders.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join("");
    mf.value = cur;
  }

  async function renameFolder(id: number) {
    const f = folders.find((x) => x.id === id);
    if (!f) return;
    const name = await A().prompt("نام جدید پوشه:", f.name, { maxLength: 120 });
    if (name === null || !name.trim() || name.trim() === f.name) return;
    await api(`/api/admin/folders/${id}`, { method: "PUT", body: { name: name.trim() } });
    await refreshFolders();
  }

  async function deleteFolder(id: number) {
    const f = folders.find((x) => x.id === id);
    if (!f) return;
    if (!(await A().confirm(`پوشه‌ی «${f.name}» حذف بشه؟ اسناد داخلش بی‌پوشه می‌شن (پاک نمی‌شن).`, { danger: true, okText: "حذف پوشه" }))) return;
    await api(`/api/admin/folders/${id}`, { method: "DELETE" });
    if (activeFolder === id) activeFolder = "all";
    if (current && current.folder_id === id) {
      current.folder_id = null;
      el<HTMLSelectElement>("metaFolder").value = "";
    }
    toast("پوشه حذف شد.");
    await refreshFolders();
    await refreshList(true);
  }

  /* ---------------- stats ---------------- */

  function updateStats() {
    const value = vditor && editorReady && current ? vditor.getValue() : current?.markdown_content || "";
    const words = countWords(value);
    const chars = value.length;
    const charsNoSpace = value.replace(/\s/g, "").length;
    const paras = value.split(/\n\s*\n/).filter((p) => p.trim()).length;
    const headings = (value.match(/^#{1,6}\s+/gm) || []).length;
    const minutes = Math.max(1, Math.round(words / 200));
    el("statWords").textContent = faNum(words);
    el("statChars").textContent = faNum(chars);
    el("statCharsNoSpace").textContent = faNum(charsNoSpace);
    el("statParas").textContent = faNum(paras);
    el("statHeadings").textContent = faNum(headings);
    el("statReading").textContent = words ? `${faNum(minutes)} دقیقه` : "—";
  }

  /* ---------------- revisions ---------------- */

  async function loadRevisions() {
    if (!current) return;
    const id = current.id;
    const res = await api(`/api/admin/documents/${id}/revisions`);
    if (!current || current.id !== id) return;
    const list = el("revisionList");
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
    list.querySelectorAll(".st-rev").forEach((node) => {
      node.addEventListener("click", () => safe(showRevision)(parseInt((node as HTMLElement).dataset.rev || "0", 10)));
    });
  }

  let viewingRev = 0;
  async function showRevision(revId: number) {
    if (!current) return;
    viewingRev = revId;
    const res = await api(`/api/admin/documents/${current.id}/revisions/${revId}`);
    const r = res.revision;
    el("revisionMeta").textContent = `نسخه‌ی ${faNum(r.version)} · ${faDate(r.created_at)} · ${r.title}`;
    el("revisionPreview").textContent = r.markdown_content;
    // On phones the revision list lives in the right drawer: close it, the modal
    // (z-index above drawers) takes over.
    if (window.innerWidth <= 1100) el("studio").classList.add("right-collapsed");
    syncBackdrop();
    el("revisionModal").hidden = false;
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
    el("moreMenu").hidden = true;
    if (!current || !vditor) {
      toast("اول یک سند رو باز کن.", true);
      return;
    }
    const value = vditor.getValue();
    const title = el<HTMLInputElement>("docTitle").value.trim() || "document";
    if (act === "export-md") {
      downloadFile(slugifyTitle(title) + ".md", value, "text/markdown;charset=utf-8");
      toast("فایل Markdown دانلود شد.");
    } else if (act === "copy-md") {
      toast((await A().copyText(value)) ? "سورس Markdown کپی شد." : "کپی نشد.", false);
    } else if (act === "copy-html") {
      const html = await Vditor.md2html(value, { cdn: cdnBase() } as any);
      toast((await A().copyText(html)) ? "HTML کپی شد." : "کپی نشد.", false);
    } else if (act === "print") {
      const html = await Vditor.md2html(value, { cdn: cdnBase() } as any);
      const w = window.open("", "_blank");
      if (!w) {
        toast("پاپ‌آپ مسدود شد.", true);
        return;
      }
      const css =
        "body{font-family:Vazirmatn,Tahoma,sans-serif;line-height:1.95;max-width:780px;margin:24px auto;padding:0 18px;color:#222}" +
        "p,li,blockquote,h1,h2,h3,h4,h5,h6{unicode-bidi:plaintext;text-align:start}" +
        "img{max-width:100%;height:auto}pre{direction:ltr;text-align:left;white-space:pre-wrap;background:#f4f1ea;padding:12px;border-radius:6px}" +
        "code{direction:ltr;unicode-bidi:embed}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}" +
        "blockquote{border-inline-start:4px solid #ccc;margin:0;padding-inline-start:12px;color:#555}";
      w.document.write(`<!DOCTYPE html><html dir="rtl" lang="fa"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}</style></head><body>${html}</body></html>`);
      w.document.close();
      w.focus();
      setTimeout(() => w.print(), 800);
    } else if (act === "manual-save") {
      await saveDoc(true);
    }
  }

  /* ---------------- panels / breakpoints ---------------- */

  function syncBackdrop() {
    const w = window.innerWidth;
    const studio = $("studio");
    const rightOpen = w <= 1100 && !studio.classList.contains("right-collapsed");
    const leftOpen = w <= 820 && !studio.classList.contains("left-collapsed");
    el("studioBackdrop").hidden = !(rightOpen || leftOpen);
  }

  function closeDrawersOnMobile() {
    if (window.innerWidth <= 820) $("studio").classList.add("left-collapsed");
    syncBackdrop();
  }

  type Bp = "mobile" | "tablet" | "desktop";
  let bp: Bp = "desktop";
  const bpNow = (): Bp => (window.innerWidth <= 820 ? "mobile" : window.innerWidth <= 1100 ? "tablet" : "desktop");
  /* Crossing a breakpoint resets the panels: shrinking the window used to leave
   * both panels "open" as drawers covering the editor, with a backdrop on top. */
  function applyBreakpoint(initial: boolean) {
    const next = bpNow();
    if (!initial && next === bp) {
      syncBackdrop();
      return;
    }
    bp = next;
    const st = $("studio");
    st.classList.toggle("left-collapsed", next === "mobile");
    st.classList.toggle("right-collapsed", next !== "desktop");
    syncBackdrop();
  }

  /* ---------------- wire up ---------------- */

  function wireEvents() {
    el("btnNewDoc").addEventListener("click", safe(newDoc));
    el("btnWelcomeNew").addEventListener("click", safe(newDoc));
    el("btnLoadMore").addEventListener("click", () => {
      refreshList(false, true).catch(listError);
    });
    el("btnImport").addEventListener("click", () => el<HTMLInputElement>("importFile").click());
    el<HTMLInputElement>("importFile").addEventListener(
      "change",
      safe(async (e: Event) => {
        const input = e.target as HTMLInputElement;
        const file = input.files && input.files[0];
        input.value = "";
        if (!file) return;
        if (file.size > MAX_DOC_BYTES) {
          toast("حجم فایل از حد مجاز (حدود ۱٫۵ مگابایت) بیشتره.", true);
          return;
        }
        const text = await file.text();
        const title = file.name.replace(/\.(md|markdown|txt)$/i, "") || "سند واردشده";
        const body: Record<string, any> = { title: title.slice(0, 300), document_type: "note", markdown_content: text };
        if (typeof activeFolder === "number") body.folder_id = activeFolder;
        const res = await api("/api/admin/documents", { method: "POST", body });
        toast("سند وارد شد.");
        await refreshList(true);
        void refreshFolders();
        closeDrawersOnMobile();
        await openDoc(res.document.id);
      })
    );

    el<HTMLInputElement>("docSearch").addEventListener("input", (e) => {
      if (searchTimer) window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        searchQ = (e.target as HTMLInputElement).value.trim();
        refreshList(true).catch(listError);
      }, 400);
    });
    ["filterType", "filterStatus", "filterSort"].forEach((id) => {
      el<HTMLSelectElement>(id).addEventListener("change", () => {
        refreshList(true).catch(listError);
      });
    });

    el("btnNewFolder").addEventListener(
      "click",
      safe(async () => {
        const name = await A().prompt("نام پوشه‌ی جدید:", "", { maxLength: 120 });
        if (!name || !name.trim()) return;
        await api("/api/admin/folders", { method: "POST", body: { name: name.trim() } });
        await refreshFolders();
      })
    );

    const title = el<HTMLInputElement>("docTitle");
    title.addEventListener("input", () => markDirty());
    title.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (vditor && editorReady) vditor.focus();
      }
    });
    // metadata edits save right away; they all go through markDirty so a request
    // already in flight cannot swallow them
    (["metaType", "metaFolder", "metaTags", "slugInput", "excerptInput"] as const).forEach((id) => {
      el(id).addEventListener("change", () => {
        if (!current) return;
        markDirty();
        void saveDoc(false);
        if (id === "metaFolder") void refreshFolders();
      });
    });
    el("metaType").addEventListener("change", () => updatePublishUI());
    el("btnPublish").addEventListener("click", safe(publishCurrent));
    el("btnUnpublish").addEventListener("click", safe(unpublishCurrent));

    document.querySelectorAll("#modeSwitcher button").forEach((b) => {
      b.addEventListener("click", safe(() => switchMode((b as HTMLElement).dataset.mode as any)));
    });

    el("btnToggleLeft").addEventListener("click", () => {
      $("studio").classList.toggle("left-collapsed");
      syncBackdrop();
    });
    el("btnToggleRight").addEventListener("click", () => {
      $("studio").classList.toggle("right-collapsed");
      syncBackdrop();
    });
    el("btnCloseLeft").addEventListener("click", () => {
      $("studio").classList.add("left-collapsed");
      syncBackdrop();
    });
    el("btnCloseRight").addEventListener("click", () => {
      $("studio").classList.add("right-collapsed");
      syncBackdrop();
    });
    el("studioBackdrop").addEventListener("click", () => {
      $("studio").classList.add("left-collapsed", "right-collapsed");
      syncBackdrop();
    });
    window.addEventListener("resize", () => applyBreakpoint(false));
    el("btnFocus").addEventListener("click", () => {
      const on = $("studio").classList.toggle("focus");
      el("btnFocus").classList.toggle("on", on);
    });

    document.addEventListener("keydown", (e) => {
      // Ctrl/Cmd+S anywhere on the page (not only inside the editor): otherwise the
      // browser's "save page as" dialog opens when focus is in the title field.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (current) safe(() => saveDoc(true))();
        return;
      }
      if (e.key === "Escape") {
        if (!el("revisionModal").hidden) {
          el("revisionModal").hidden = true;
        } else if (!el("moreMenu").hidden) {
          el("moreMenu").hidden = true;
        } else if (!el("studioBackdrop").hidden) {
          $("studio").classList.add("left-collapsed", "right-collapsed");
          syncBackdrop();
        }
      }
    });

    el("btnMore").addEventListener("click", (e) => {
      e.stopPropagation();
      el("moreMenu").hidden = !el("moreMenu").hidden;
    });
    document.addEventListener("click", (e) => {
      const wrap = document.querySelector(".st-menu-wrap");
      if (wrap && !wrap.contains(e.target as Node)) el("moreMenu").hidden = true;
    });
    document.querySelectorAll("#moreMenu button").forEach((b) => {
      b.addEventListener("click", safe(() => menuAction((b as HTMLElement).dataset.act || "")));
    });

    el("btnPin").addEventListener("click", () => {
      if (current) safe(docAction)(current.id, "pin");
    });
    el("btnDuplicate").addEventListener("click", () => {
      if (current) safe(docAction)(current.id, "duplicate");
    });

    /* archive / restore: ONE button whose meaning follows the document's status.
       (Trashed documents used to have no "restore" at all: the button archived them.) */
    el("btnArchive").addEventListener(
      "click",
      safe(async () => {
        if (!current) return;
        const st = current.status;
        if (st === "archived" || st === "trashed") {
          const r = await api(`/api/admin/documents/${current.id}/restore`, { method: "POST" });
          toast(r.slug_cleared ? "بازیابی شد؛ اسلاگش با نوشته‌ی دیگه‌ای تداخل داشت و پاک شد." : st === "trashed" ? "بازیابی شد." : "از بایگانی برگشت.");
        } else {
          await saveDoc(false);
          await api(`/api/admin/documents/${current.id}/archive`, { method: "POST" });
          toast("بایگانی شد.");
        }
        closeDoc();
        await refreshList(true);
        void refreshFolders();
      })
    );
    el("btnTrash").addEventListener(
      "click",
      safe(async () => {
        if (!current) return;
        const inTrash = current.status === "trashed";
        const ok = await A().confirm(inTrash ? "این سند برای همیشه حذف بشه؟ این عمل برگشت‌ناپذیره." : "این سند به سطل زباله منتقل بشه؟", {
          danger: true,
          okText: inTrash ? "حذف دائمی" : "انتقال به سطل زباله",
        });
        if (!ok) return;
        const id = current.id;
        if (inTrash) {
          await api(`/api/admin/documents/${id}?permanent=1`, { method: "DELETE" });
          toast("برای همیشه حذف شد.");
        } else {
          await saveDoc(false);
          // a published document answers 409 must_unpublish_first: safe() shows it
          await api(`/api/admin/documents/${id}`, { method: "DELETE" });
          toast("به سطل زباله منتقل شد.");
        }
        clearRecovery(id);
        closeDoc();
        await refreshList(true);
        void refreshFolders();
      })
    );

    el("revisionClose").addEventListener("click", () => {
      el("revisionModal").hidden = true;
    });
    el("revisionModal").addEventListener("mousedown", (e) => {
      if (e.target === el("revisionModal")) el("revisionModal").hidden = true;
    });
    el("revisionRestore").addEventListener(
      "click",
      safe(async () => {
        if (!current || !viewingRev) return;
        if (!(await A().confirm("این نسخه بازیابی بشه؟ محتوای فعلی به‌عنوان نسخه‌ی جدید ذخیره می‌شه.", { okText: "بازیابی" }))) return;
        // The server snapshots ITS copy before restoring: make sure that is what's on screen.
        if (!(await saveDoc(false))) {
          toast("ابتدا باید ذخیره‌ی سند موفق باشه.", true);
          return;
        }
        await api(`/api/admin/documents/${current.id}/revisions/${viewingRev}/restore`, { method: "POST" });
        el("revisionModal").hidden = true;
        toast("نسخه بازیابی شد.");
        await openDoc(current.id, true);
      })
    );

    window.addEventListener("beforeunload", (e) => {
      if (dirty) {
        stashRecovery();
        e.preventDefault();
        e.returnValue = "";
      }
    });
    // Phones kill background tabs without warning: persist when the page is hidden.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && dirty && current) {
        stashRecovery();
        void saveDoc(false);
      }
    });
    window.addEventListener("adm-theme", applyTheme);

    applyBreakpoint(true);
    updateActionButtons();
  }

  /* ---------------- boot ---------------- */

  async function boot() {
    try {
      await A().ready;
    } catch {
      return;
    }
    el("studio").hidden = false;
    syncModeButtons();
    wireEvents();
    try {
      await refreshFolders();
      await refreshList(false);
      const qs = new URLSearchParams(location.search);
      const fromUrl = qs.get("doc");
      const wanted = fromUrl && /^\d+$/.test(fromUrl) ? parseInt(fromUrl, 10) : null;
      if (qs.get("new") === "1") {
        history.replaceState(null, "", location.pathname);
        await newDoc();
        return;
      }
      // ?doc=ID opens that document even if it isn't in the first page of the list
      // (or is archived): the old code silently opened a different one.
      if (wanted) {
        try {
          await openDoc(wanted, true);
          return;
        } catch (e: any) {
          if (e && e.message === "unauthorized") return;
          toast("سند درخواستی پیدا نشد.", true);
        }
      }
      const last = lsGet("ahura-studio-last");
      const lastId = last && docs.some((d) => d.id === parseInt(last, 10)) ? parseInt(last, 10) : null;
      const target = lastId ?? docs[0]?.id;
      if (target) {
        await openDoc(target, true);
      } else {
        showEditor(false);
      }
    } catch (e: any) {
      if (e && e.message !== "unauthorized") toast("خطا در بارگذاری: " + errText(e), true);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    void boot();
  }
}
