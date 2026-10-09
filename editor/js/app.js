// Интерфейс анкеты (D-030): подключение, экраны, корзина, отправка.
// Весь текст — через textContent (никакого innerHTML с данными редактора).
import { COLLECTIONS, LABELS, NAME_FIELDS, TEXT_KEYS, applyOps, describeOp, mergeOps, newEntryId, opKey } from "./content.js";
import { createDemoFetch } from "./demo.js";
import { EditorError, check, connect, listQueues, submit } from "./flow.js";
import { explainError } from "./github.js";

const STORAGE_TOKEN = "names99-editor.token";
const STORAGE_DRAFT = "names99-editor.draft.";
const DEMO_FILES_BASE = "../../../core/data/src/commonMain/composeResources/files/";

const state = {
  session: null,
  draft: [],
  view: "names",
  selectedName: 1,
  search: "",
  editing: null, // { collection, entry } — открытая форма записи
  busy: false,
};

// --- DOM-помощники ------------------------------------------------------------
const $ = (id) => document.getElementById(id);
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name === "class") node.className = value;
    else if (name === "text") node.textContent = value;
    else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(name, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}
function replace(node, children) {
  node.replaceChildren(...[].concat(children).filter(Boolean));
}

// --- Состояние ----------------------------------------------------------------
const safeStorage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* приватный режим — живём без памяти */
    }
  },
};

function persistDraft() {
  if (!state.session) return;
  safeStorage.set(STORAGE_DRAFT + state.session.login, JSON.stringify(state.draft));
}
function loadDraft(login) {
  state.draftNote = "";
  try {
    const raw = safeStorage.get(STORAGE_DRAFT + login);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed) || !parsed.every((op) => op && OP_KINDS.has(op.kind))) throw new Error("bad draft");
    state.draft = parsed;
  } catch {
    state.draft = [];
    state.draftNote = "Сохранённый черновик повреждён — начат заново.";
  }
}

/** Состояние «как после мержа очереди» — то, относительно чего редактор правит. */
function queued() {
  return applyOps(state.session.base, state.session.queue?.ops || []);
}
/** Состояние с черновиком — то, что видно в полях. */
function effective() {
  return applyOps(queued(), state.draft);
}

const normalize = (value) => String(value ?? "").normalize("NFC").replace(/\r\n/g, "\n").trim();
/** Арабские поля — одна строка: перенос строки в них правило «только арабские буквы» не пропускает. */
const normalizeArabic = (value) => normalize(value).replace(/\s+/g, " ");
const OP_KINDS = new Set(["name", "chechen", "text", "entry", "entryDelete"]);

/** Правка поля: если значение вернулось к очереди/базе — черновик по этой цели снимается. */
function addDraftOp(op) {
  const key = opKey(op);
  state.draft = state.draft.filter((item) => opKey(item) !== key);
  const before = queued();
  let same = false;
  if (op.kind === "name") same = before.names.find((n) => n.id === op.id)?.[op.field] === op.value;
  else if (op.kind === "chechen") same = before.chechen.get(op.id) === op.value;
  else if (op.kind === "text") same = (before.texts.get(op.key) ?? "") === op.value;
  // Удаление записи, которой нет ни в main, ни в очереди, — просто снять черновик (L1b).
  else if (op.kind === "entryDelete") same = !before.collections[op.collection].some((entry) => entry.id === op.id);
  if (!same) state.draft.push(op);
  persistDraft();
  renderCart();
}

// --- Подключение --------------------------------------------------------------
const CONNECT_ERRORS = {
  "no-access": "Токен принят, но репозиторий names99-content не виден. Проверьте, что приглашение принято, а токен — classic с правом repo.",
  "fork-pending": "GitHub ещё создаёт вашу копию репозитория. Подождите минуту и нажмите «Проверить» снова.",
  "fork-foreign": "У вас уже есть свой репозиторий names99-content, не связанный с нашим. Переименуйте его и повторите.",
  "fork-conflict": "Вашу копию не удалось обновить из основного репозитория. Напишите автору.",
  "no-branch": "В репозитории нет ветки main.",
  nothing: "Черновик пуст — отправлять нечего.",
};

function explain(error) {
  if (error instanceof EditorError) {
    if (error.code === "invalid") return "Есть ошибки, отправка остановлена: " + error.details.join("; ");
    return CONNECT_ERRORS[error.code] || `Ошибка: ${error.code}`;
  }
  return explainError(error);
}

async function demoFetch(mode) {
  const files = new Map();
  for (const name of ["names.json", "names_transliteration_chechen.json"]) {
    const response = await fetch(DEMO_FILES_BASE + name);
    files.set(`content/${name}`, await response.text());
  }
  files.set("content/version.json", '{\n  "contentVersion": 2\n}\n');
  for (const collection of COLLECTIONS) files.set(`content/collections/${collection}.json`, "[]\n");
  return createDemoFetch({ files, login: mode === "owner" ? "Baudi2" : "demo-editor" });
}

async function doConnect() {
  const demo = new URLSearchParams(location.search).get("demo");
  const token = demo ? "demo" : $("token").value.trim();
  if (!token) {
    setStatus("connect-status", "Вставьте токен.", "error");
    return;
  }
  setBusy(true);
  setStatus("connect-status", "Проверяю доступ…");
  try {
    const fetchImpl = demo ? await demoFetch(demo) : undefined;
    window.__names99Demo = fetchImpl; // демо-кнопки «владелец смержил»
    state.session = await connect({ token, fetchImpl });
    // Демо хранилище токена не трогает (L1b).
    if (!demo) safeStorage.set(STORAGE_TOKEN, $("remember").checked ? token : null);
    loadDraft(state.session.login);
    const q = state.session.queue;
    setStatus(
      "connect-status",
      `Вы вошли как ${state.session.login}${state.session.isOwner ? " (владелец)" : ""}. ` +
        (q ? `В очереди ${q.ops.length} правок, ждут подтверждения.` : "Очередь пуста."),
      "ok",
    );
    $("main").hidden = false;
    $("connect").classList.add("compact");
    renderAll();
  } catch (error) {
    setStatus("connect-status", explain(error), "error");
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  state.busy = busy;
  for (const button of document.querySelectorAll("button")) button.disabled = busy;
  // Кнопка отправки живёт по своим правилам (черновик + ошибки), не по busy (L1b).
  if (!busy && state.session) renderCart();
}
function setStatus(id, text, kind = "") {
  const node = $(id);
  node.textContent = text;
  node.className = `status ${kind}`;
}

// --- Экраны -------------------------------------------------------------------
function renderAll() {
  for (const button of document.querySelectorAll("#tabs button")) {
    button.classList.toggle("active", button.dataset.view === state.view);
  }
  const view = $("view");
  if (state.view === "names") renderNames(view);
  else if (state.view === "texts") renderTexts(view);
  else renderCollection(view, state.view);
  renderCart();
  renderOwner();
}

function field(label, control, hint) {
  return el("label", { class: "field" }, [el("span", { class: "field-label", text: label }), control, hint ? el("small", { text: hint }) : null]);
}

function renderNames(view) {
  // Поле поиска не пересоздаётся при вводе — иначе теряет фокус после каждой буквы (L1b).
  const body = el("div", { class: "two-col" });
  const search = el("input", {
    type: "search",
    placeholder: "Номер или слово, например 86 или Гани",
    value: state.search,
    oninput: (event) => {
      state.search = event.target.value;
      fillNamesBody(body);
    },
  });
  replace(view, [
    el("h2", { text: "Имена" }),
    el("p", { class: "muted", text: "Имя нельзя добавить или удалить — приложение ждёт ровно 99. Правятся тексты." }),
    search,
    body,
  ]);
  fillNamesBody(body);
}

function fillNamesBody(body) {
  const content = effective();
  const query = state.search.trim().toLowerCase();
  const matches = content.names.filter((name) => {
    if (!query) return true;
    if (/^\d+$/.test(query)) return String(name.id) === query;
    return [name.transliteration, name.translation, content.chechen.get(name.id) || ""].some((v) => v.toLowerCase().includes(query));
  });
  const selected = matches.find((name) => name.id === state.selectedName) || matches[0];
  const list = el("div", { class: "name-list" }, matches.map((name) =>
    el("button", {
      class: "name-row" + (selected && name.id === selected.id ? " selected" : ""),
      onclick: () => {
        state.selectedName = name.id;
        fillNamesBody(body);
      },
    }, [el("b", { text: `${name.id}. ${name.transliteration}` }), el("span", { text: name.translation })]),
  ));
  const card = selected ? nameCard(selected, content) : el("p", { text: "Ничего не найдено." });
  replace(body, [list, card]);
}

function nameCard(name, content) {
  const input = (fieldName, multiline, dir) => {
    const control = el(multiline ? "textarea" : "input", {
      value: multiline ? undefined : name[fieldName],
      dir,
      rows: multiline ? 5 : undefined,
      lang: dir === "rtl" ? "ar" : "ru",
      onchange: (event) =>
        addDraftOp({
          kind: "name",
          id: name.id,
          field: fieldName,
          value: fieldName === "arabic" ? normalizeArabic(event.target.value) : normalize(event.target.value),
        }),
    });
    if (multiline) control.value = name[fieldName];
    return control;
  };
  const chechen = el("input", {
    value: content.chechen.get(name.id) || "",
    onchange: (event) => addDraftOp({ kind: "chechen", id: name.id, value: normalize(event.target.value) }),
  });
  return el("div", { class: "card" }, [
    el("h3", { text: `Имя ${name.id}` }),
    field("Арабское написание", input("arabic", false, "rtl"), "Только арабские буквы и огласовки."),
    field("Транслитерация (русская)", input("transliteration", false)),
    field("Транслитерация (чеченская)", chechen, "Палочка — заглавная латинская I или строчная l."),
    field("Перевод", input("translation", false)),
    field("Значение", input("meaning", true), "Слово «Имя» об Именах Аллаха — с заглавной."),
    field("Аудио", el("input", { value: name.audioFile, disabled: "" }), "Аудио меняется только вместе с приложением."),
  ]);
}

function renderTexts(view) {
  const content = effective();
  replace(view, [
    el("h2", { text: "Тексты экранов" }),
    el("p", { class: "muted", text: "Пустое поле — приложение покажет встроенный текст." }),
    ...TEXT_KEYS.map((key) => {
      const area = el("textarea", {
        rows: 8,
        onchange: (event) => addDraftOp({ kind: "text", key, value: normalize(event.target.value) }),
      });
      area.value = content.texts.get(key) || "";
      return el("div", { class: "card" }, [field(LABELS.text[key], area)]);
    }),
  ]);
}

function renderCollection(view, collection) {
  const content = effective();
  const list = content.collections[collection];
  const rows = list.map((entry) =>
    el("div", { class: "entry-row" }, [
      el("div", {}, [el("b", { text: entry.translation || entry.id }), el("span", { class: "muted", text: ` · Имена: ${(entry.nameIds || []).join(", ") || "—"}` })]),
      el("div", { class: "row-actions" }, [
        el("button", { text: "Изменить", onclick: () => { state.editing = { collection, entry: { ...entry } }; renderAll(); } }),
        el("button", { class: "danger", text: "Удалить", onclick: () => { addDraftOp({ kind: "entryDelete", collection, id: entry.id }); state.editing = null; renderAll(); } }),
      ]),
    ]),
  );
  const addButton = el("button", {
    class: "primary",
    text: `Добавить ${LABELS.collectionOne[collection]}`,
    onclick: () => {
      const ids = list.map((entry) => entry.id);
      state.editing = { collection, entry: { id: newEntryId(collection, ids), arabic: "", translation: "", source: "", nameIds: [], note: "" }, isNew: true };
      renderAll();
    },
  });
  replace(view, [
    el("h2", { text: LABELS.collection[collection] }),
    el("p", { class: "muted", text: "Запись появится в приложении, когда появится экран для неё; хранить можно уже сейчас." }),
    rows.length ? el("div", { class: "entry-list" }, rows) : el("p", { class: "muted", text: "Пока ни одной записи." }),
    addButton,
    state.editing && state.editing.collection === collection ? entryForm(state.editing) : null,
  ]);
}

function entryForm(editing) {
  const entry = editing.entry;
  const control = (name, multiline, dir) => {
    const node = el(multiline ? "textarea" : "input", { dir, rows: multiline ? 4 : undefined, lang: dir === "rtl" ? "ar" : "ru" });
    node.value = entry[name] || "";
    node.addEventListener("input", (event) => { entry[name] = event.target.value; });
    return node;
  };
  const ids = el("input", { value: (entry.nameIds || []).join(", "), placeholder: "например 1, 5, 86" });
  ids.addEventListener("input", (event) => {
    entry.nameIds = event.target.value.split(/[,\s;]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n));
  });
  const errorBox = el("p", { class: "status error" });
  return el("div", { class: "card entry-form" }, [
    el("h3", { text: editing.isNew ? `Новый ${LABELS.collectionOne[editing.collection]}` : "Изменить запись" }),
    field("Арабский текст", control("arabic", true, "rtl")),
    field("Перевод", control("translation", true)),
    field("Источник", control("source", false), "Например, сборник и номер."),
    field("Связанные Имена (номера через запятую)", ids),
    field("Примечание", control("note", true)),
    errorBox,
    el("div", { class: "row-actions" }, [
      el("button", {
        class: "primary",
        text: "Сохранить в черновик",
        onclick: () => {
          const clean = {
            id: entry.id,
            arabic: normalizeArabic(entry.arabic),
            translation: normalize(entry.translation),
            source: normalize(entry.source),
            nameIds: [...new Set(entry.nameIds || [])].sort((a, b) => a - b),
            note: normalize(entry.note),
          };
          if (!clean.arabic || !clean.translation) {
            errorBox.textContent = "Арабский текст и перевод обязательны.";
            return;
          }
          addDraftOp({ kind: "entry", collection: editing.collection, entry: clean });
          state.editing = null;
          renderAll();
        },
      }),
      el("button", { text: "Отмена", onclick: () => { state.editing = null; renderAll(); } }),
    ]),
  ]);
}

// --- Корзина ------------------------------------------------------------------
function renderCart() {
  if (!state.session) return;
  const base = queued();
  const draftList = state.draft.length
    ? el("ul", {}, mergeOps(state.draft).map((op) =>
        el("li", {}, [
          describeOp(op, base),
          el("button", { class: "link", text: "убрать", onclick: () => { state.draft = state.draft.filter((item) => opKey(item) !== opKey(op)); persistDraft(); renderAll(); } }),
        ]),
      ))
    : el("p", { class: "muted", text: "Пока пусто. Измените поле — правка появится здесь." });
  const queue = state.session.queue;
  const queueList = queue
    ? el("div", {}, [
        el("ul", {}, queue.ops.map((op) => el("li", { text: describeOp(op, state.session.base) }))),
        el("p", { class: "muted" }, [
          `Отправок: ${queue.submissions.length}. `,
          queue.prUrl ? el("a", { href: queue.prUrl, target: "_blank", rel: "noopener", text: "Открыть запрос на утверждение" }) : "Запрос будет создан при следующей отправке.",
        ]),
      ])
    : el("p", { class: "muted", text: "Очередь пуста: всё отправленное уже принято автором или отправок ещё не было." });
  const verdict = check(state.session, state.draft);
  // Предупреждения показываем только НОВЫЕ — шесть известных по значениям
  // Имён (D-026) живут в базе и к черновику отношения не имеют.
  const known = new Set(check(state.session, []).warnings);
  const problems = el("div", {}, [
    ...verdict.errors.map((text) => el("p", { class: "status error", text })),
    ...verdict.warnings.filter((text) => !known.has(text)).map((text) => el("p", { class: "status warn", text })),
  ]);
  replace($("cart"), [
    el("h2", { text: "Корзина" }),
    el("h3", { text: "Не отправлено" }),
    state.draftNote ? el("p", { class: "status warn", text: state.draftNote }) : null,
    draftList,
    problems,
    el("button", {
      id: "submit-btn",
      class: "primary",
      text: "Отправить на утверждение",
      disabled: state.draft.length && !verdict.errors.length && !state.busy ? null : "",
      onclick: doSubmit,
    }),
    el("p", { id: "submit-status", class: "status" }),
    el("h3", { text: "В очереди на утверждение" }),
    queueList,
  ]);
}

async function doSubmit() {
  setBusy(true);
  setStatus("submit-status", "Отправляю…");
  try {
    const known = new Set(check(state.session, []).warnings);
    const result = await submit(state.session, state.draft);
    state.draft = [];
    persistDraft();
    renderAll();
    const fresh = result.warnings.filter((text) => !known.has(text));
    const warn = fresh.length ? ` Предупреждения: ${fresh.join("; ")}.` : "";
    setStatus("submit-status", `Отправлено: ${result.title}. Ждёт подтверждения автора (версия ${result.version}).${warn}`, "ok");
  } catch (error) {
    renderAll();
    setStatus("submit-status", explain(error), "error");
  } finally {
    setBusy(false);
  }
}

// --- Режим владельца ----------------------------------------------------------
async function renderOwner() {
  const panel = $("owner");
  if (!state.session?.isOwner) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  try {
    const queues = await listQueues(state.session);
    replace(panel, [
      el("h2", { text: "Очереди редакторов" }),
      queues.length
        ? el("ul", {}, queues.map((q) => el("li", {}, [el("a", { href: q.url, target: "_blank", rel: "noopener", text: `${q.login}: отправок ${q.submissions.length}` })])))
        : el("p", { class: "muted", text: "Открытых очередей нет." }),
    ]);
  } catch (error) {
    replace(panel, [el("p", { class: "status error", text: explain(error) })]);
  }
}

// --- Старт --------------------------------------------------------------------
function init() {
  const demo = new URLSearchParams(location.search).get("demo");
  for (const button of document.querySelectorAll("#tabs button")) {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      state.editing = null;
      renderAll();
    });
  }
  $("connect-btn").addEventListener("click", doConnect);
  $("token").addEventListener("keydown", (event) => {
    if (event.key === "Enter") doConnect();
  });
  const saved = safeStorage.get(STORAGE_TOKEN);
  if (saved) {
    $("token").value = saved;
    $("remember").checked = true;
  }
  if (demo) {
    $("demo-banner").hidden = false;
    $("demo-merge").addEventListener("click", async () => {
      const number = state.session?.queue?.prNumber;
      if (!number) return;
      window.__names99Demo.mergePull(number);
      await doConnect();
    });
    doConnect();
  }
}

init();
