// Модель контента анкеты (D-030): файлы репозитория names99-content ↔ объект,
// правки как список операций, применение, пересборка файлов, восстановление
// очереди из разницы двух состояний. Чистые функции — тестируются в Node.
// Религиозный текст модель не меняет и не сочиняет: только переносит то,
// что ввёл редактор.

export const PATHS = {
  names: "content/names.json",
  chechen: "content/names_transliteration_chechen.json",
  version: "content/version.json",
  textsDir: "content/texts",
  collections: {
    dua: "content/collections/dua.json",
    hadith: "content/collections/hadith.json",
    ayat: "content/collections/ayat.json",
  },
};

export const COLLECTIONS = ["dua", "hadith", "ayat"];
export const NAME_FIELDS = ["arabic", "transliteration", "translation", "meaning"];
export const ENTRY_FIELDS = ["arabic", "translation", "source", "note"];
export const TEXT_KEYS = ["about.sources", "about.transliteration"];

export const LABELS = {
  field: {
    arabic: "арабский",
    transliteration: "транслитерация",
    translation: "перевод",
    meaning: "значение",
    source: "источник",
    note: "примечание",
    nameIds: "связанные Имена",
  },
  collection: { dua: "Дуа", hadith: "Хадисы", ayat: "Аяты" },
  collectionOne: { dua: "дуа", hadith: "хадис", ayat: "аят" },
  text: { "about.sources": "«О приложении» → Источники", "about.transliteration": "«О приложении» → О транслитерации" },
};

const textPath = (key) => `${PATHS.textsDir}/${key}.txt`;
const textKeyOf = (path) =>
  path.startsWith(PATHS.textsDir + "/") && path.endsWith(".txt")
    ? path.slice(PATHS.textsDir.length + 1, -".txt".length)
    : null;

function parseJson(text, fallback) {
  if (text === null || text === undefined) return fallback;
  return JSON.parse(text.replace(/^﻿/, ""));
}

/** Файлы репозитория (Map путь → текст) → объект контента. */
export function parseContent(files) {
  const get = (path) => (files.has(path) ? files.get(path) : null);
  const names = parseJson(get(PATHS.names), []);
  const chechen = new Map(parseJson(get(PATHS.chechen), []).map((row) => [row.id, row.transliteration]));
  const versionJson = parseJson(get(PATHS.version), { contentVersion: 0 });
  const texts = new Map();
  for (const [path, text] of files) {
    const key = textKeyOf(path);
    if (key !== null && text !== null) texts.set(key, text.replace(/\r\n/g, "\n").trim());
  }
  const collections = {};
  for (const name of COLLECTIONS) collections[name] = parseJson(get(PATHS.collections[name]), []);
  return { version: versionJson.contentVersion, names, chechen, texts, collections };
}

const json = (value) => JSON.stringify(value, null, 2) + "\n";

/** Объект контента → файлы (Map путь → текст) в формате репозитория (LF, отступ 2). */
export function serializeFiles(content) {
  const files = new Map();
  files.set(PATHS.names, json(content.names));
  files.set(
    PATHS.chechen,
    json(
      [...content.chechen.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([id, transliteration]) => ({ id, transliteration })),
    ),
  );
  files.set(PATHS.version, json({ contentVersion: content.version }));
  for (const [key, text] of content.texts) files.set(textPath(key), text + "\n");
  for (const name of COLLECTIONS) files.set(PATHS.collections[name], json(content.collections[name]));
  return files;
}

export function cloneContent(content) {
  return {
    version: content.version,
    names: content.names.map((name) => ({ ...name })),
    chechen: new Map(content.chechen),
    texts: new Map(content.texts),
    collections: Object.fromEntries(
      COLLECTIONS.map((name) => [
        name,
        // nameIds не придумываем: запись без поля так и остаётся без поля (иначе ложный diff файла).
        content.collections[name].map((entry) => (entry.nameIds ? { ...entry, nameIds: [...entry.nameIds] } : { ...entry })),
      ]),
    ),
  };
}

// --- Операции ---------------------------------------------------------------
// { kind: "name", id, field, value }
// { kind: "chechen", id, value }
// { kind: "text", key, value }            value "" — удалить файл
// { kind: "entry", collection, entry }    upsert по entry.id
// { kind: "entryDelete", collection, id }

export function opKey(op) {
  switch (op.kind) {
    case "name":
      return `name:${op.id}:${op.field}`;
    case "chechen":
      return `chechen:${op.id}`;
    case "text":
      return `text:${op.key}`;
    case "entry":
      return `entry:${op.collection}:${op.entry.id}`;
    case "entryDelete":
      return `entry:${op.collection}:${op.id}`;
    default:
      throw new Error(`unknown op kind ${op.kind}`);
  }
}

/** Свёртка: по одной операции на цель, побеждает последняя; порядок — первого появления. */
export function mergeOps(ops) {
  const merged = new Map();
  for (const op of ops) merged.set(opKey(op), op);
  return [...merged.values()];
}

export function applyOps(base, ops) {
  const content = cloneContent(base);
  for (const op of ops) {
    switch (op.kind) {
      case "name": {
        const name = content.names.find((item) => item.id === op.id);
        if (!name) throw new Error(`Имя ${op.id} не найдено`);
        if (!NAME_FIELDS.includes(op.field)) throw new Error(`поле ${op.field} не правится`);
        name[op.field] = op.value;
        break;
      }
      case "chechen":
        content.chechen.set(op.id, op.value);
        break;
      case "text":
        if (op.value === "" || op.value === null) content.texts.delete(op.key);
        else content.texts.set(op.key, op.value);
        break;
      case "entry": {
        const list = content.collections[op.collection];
        const index = list.findIndex((entry) => entry.id === op.entry.id);
        const entry = { ...op.entry, nameIds: [...(op.entry.nameIds || [])] };
        if (index >= 0) list[index] = entry;
        else list.push(entry);
        break;
      }
      case "entryDelete": {
        const list = content.collections[op.collection];
        content.collections[op.collection] = list.filter((entry) => entry.id !== op.id);
        break;
      }
      default:
        throw new Error(`unknown op kind ${op.kind}`);
    }
  }
  return content;
}

function sameEntry(a, b) {
  return (
    ENTRY_FIELDS.every((field) => (a[field] ?? "") === (b[field] ?? "")) &&
    JSON.stringify(a.nameIds || []) === JSON.stringify(b.nameIds || [])
  );
}

/** Разница base → head как список операций (восстановление очереди из ветки). */
export function diffContent(base, head) {
  const ops = [];
  for (const name of head.names) {
    const before = base.names.find((item) => item.id === name.id);
    if (!before) continue;
    for (const field of NAME_FIELDS) {
      if (before[field] !== name[field]) ops.push({ kind: "name", id: name.id, field, value: name[field] });
    }
  }
  for (const [id, value] of head.chechen) {
    if (base.chechen.get(id) !== value) ops.push({ kind: "chechen", id, value });
  }
  for (const key of new Set([...base.texts.keys(), ...head.texts.keys()])) {
    const before = base.texts.get(key) ?? "";
    const after = head.texts.get(key) ?? "";
    if (before !== after) ops.push({ kind: "text", key, value: after });
  }
  for (const collection of COLLECTIONS) {
    const before = new Map(base.collections[collection].map((entry) => [entry.id, entry]));
    for (const entry of head.collections[collection]) {
      const old = before.get(entry.id);
      if (!old || !sameEntry(old, entry)) ops.push({ kind: "entry", collection, entry });
    }
    const after = new Set(head.collections[collection].map((entry) => entry.id));
    for (const id of before.keys()) if (!after.has(id)) ops.push({ kind: "entryDelete", collection, id });
  }
  return ops;
}

/**
 * Отправка: файлы = base + вся очередь, версия = версия main + 1; в files
 * только изменившиеся пути (null = удалить). Без правок — только version.json.
 */
export function buildSubmission(base, ops) {
  const merged = mergeOps(ops);
  const head = applyOps(base, merged);
  head.version = base.version + 1;
  const before = serializeFiles(base);
  const after = serializeFiles(head);
  const files = new Map();
  for (const [path, text] of after) if (before.get(path) !== text) files.set(path, text);
  for (const path of before.keys()) if (!after.has(path)) files.set(path, null);
  return { content: head, files, version: head.version, ops: merged };
}

/** Случайный хвост — два редактора в один день не получат один id и не затрут друг друга (L1b). */
function randomSuffix(random = globalThis.crypto) {
  const bytes = new Uint8Array(3);
  random.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newEntryId(collection, existingIds, date = new Date(), random = globalThis.crypto) {
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  const taken = new Set(existingIds);
  for (;;) {
    const id = `${collection}-${stamp}-${randomSuffix(random)}`;
    if (!taken.has(id)) return id;
  }
}

const SHORT = 60;
export function quote(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text === "") return "пусто";
  return "«" + (text.length <= SHORT ? text : text.slice(0, SHORT - 1) + "…") + "»";
}

function nameLabel(base, id) {
  const name = base.names.find((item) => item.id === id);
  return name ? `Имя ${id} (${name.transliteration})` : `Имя ${id}`;
}

/** Одна операция словами: «было → стало». [base] — состояние, от которого считается «было». */
export function describeOp(op, base) {
  switch (op.kind) {
    case "name": {
      const before = base.names.find((item) => item.id === op.id)?.[op.field];
      return `${nameLabel(base, op.id)}: ${LABELS.field[op.field]} ${quote(before)} → ${quote(op.value)}`;
    }
    case "chechen":
      return `${nameLabel(base, op.id)}: чеченская транслитерация ${quote(base.chechen.get(op.id))} → ${quote(op.value)}`;
    case "text": {
      const label = LABELS.text[op.key] || op.key;
      const before = base.texts.get(op.key);
      if (!op.value) return `Текст ${label}: удалён (приложение покажет встроенный)`;
      return `Текст ${label}: ${before === undefined ? "добавлен" : "изменён"} (${op.value.length} симв.)`;
    }
    case "entry": {
      const list = base.collections[op.collection];
      const old = list.find((entry) => entry.id === op.entry.id);
      const what = LABELS.collectionOne[op.collection];
      if (!old) return `Добавлен ${what}: ${quote(op.entry.translation)}`;
      const changed = ENTRY_FIELDS.filter((field) => (old[field] ?? "") !== (op.entry[field] ?? "")).map(
        (field) => LABELS.field[field],
      );
      if (JSON.stringify(old.nameIds || []) !== JSON.stringify(op.entry.nameIds || [])) changed.push(LABELS.field.nameIds);
      return `Изменён ${what} ${quote(old.translation)}: ${changed.join(", ") || "без изменений"}`;
    }
    case "entryDelete": {
      const old = base.collections[op.collection].find((entry) => entry.id === op.id);
      return `Удалён ${LABELS.collectionOne[op.collection]} ${quote(old ? old.translation : op.id)}`;
    }
    default:
      return JSON.stringify(op);
  }
}

/** Очередь словами по порядку операций. */
export function describeOps(ops, base) {
  return mergeOps(ops).map((op) => describeOp(op, base));
}
