// Заголовки отправок и тело PR с очередью (D-030, AC-6). Чистые функции.
import { LABELS, describeOps, mergeOps } from "./content.js";

const PLURALS = {
  hadith: ["хадис", "хадиса", "хадисов"],
  ayat: ["аят", "аята", "аятов"],
  dua: ["дуа", "дуа", "дуа"],
  names: ["Имя", "Имени", "Имён"],
};

export function plural(n, forms) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
}

/** «Имя 86: транслитерация, перевод; +3 дуа; изменён 1 хадис» — по свёрнутым операциям. */
export function submissionTitle(ops, base) {
  const merged = mergeOps(ops);
  const parts = [];
  const byName = new Map();
  for (const op of merged) {
    if (op.kind === "name") {
      if (!byName.has(op.id)) byName.set(op.id, []);
      byName.get(op.id).push(LABELS.field[op.field]);
    } else if (op.kind === "chechen") {
      if (!byName.has(op.id)) byName.set(op.id, []);
      byName.get(op.id).push("чеченская транслитерация");
    }
  }
  const nameIds = [...byName.keys()].sort((a, b) => a - b);
  if (nameIds.length === 1) parts.push(`Имя ${nameIds[0]}: ${byName.get(nameIds[0]).join(", ")}`);
  else if (nameIds.length > 1) parts.push(`${nameIds.length} ${plural(nameIds.length, PLURALS.names)}: ${nameIds.join(", ")}`);
  const texts = merged.filter((op) => op.kind === "text");
  if (texts.length) parts.push(`${texts.length === 1 ? "текст экрана" : `тексты экранов (${texts.length})`}`);
  for (const collection of ["dua", "hadith", "ayat"]) {
    const existing = new Set(base.collections[collection].map((entry) => entry.id));
    const added = merged.filter((op) => op.kind === "entry" && op.collection === collection && !existing.has(op.entry.id)).length;
    const changed = merged.filter((op) => op.kind === "entry" && op.collection === collection && existing.has(op.entry.id)).length;
    const removed = merged.filter((op) => op.kind === "entryDelete" && op.collection === collection).length;
    if (added) parts.push(`+${added} ${plural(added, PLURALS[collection])}`);
    if (changed) parts.push(`${changed === 1 ? "изменён" : "изменено"} ${changed} ${plural(changed, PLURALS[collection])}`);
    if (removed) parts.push(`${removed === 1 ? "удалён" : "удалено"} ${removed} ${plural(removed, PLURALS[collection])}`);
  }
  return parts.join("; ") || "без изменений";
}

export function formatDateTime(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Текст редактора в markdown тела PR: ни разметки, ни упоминаний, ни
 * HTML-комментариев (L1b). Экранируются только символы, открывающие
 * разметку, — дефисы и скобки остаются читаемыми.
 */
export function escapeMarkdown(text) {
  return String(text).replace(/[\\`*_[\]<>@!|~]/g, (c) => "\\" + c);
}

const MARKER_START = "<!-- names99-queue ";
const MARKER_END = " -->";

/** Тело PR: очередь отправок для автора + скрытый JSON для восстановления анкетой. */
export function queueBody({ login, submissions, ops, base, editorUrl }) {
  const lines = [
    `## Очередь правок от @${login}`,
    "",
    "Отправлено через анкету редактора. Каждая отправка пересобирает ветку от текущего `main`:",
    "мержится один раз, целиком; проверка и сводка «было → стало» — в Actions → check.",
    "",
    "### Отправки",
  ];
  submissions.forEach((item, index) => lines.push(`${index + 1}. ${escapeMarkdown(item.at)} — ${escapeMarkdown(item.title)}`));
  lines.push("", "### Что в очереди сейчас");
  for (const line of describeOps(ops, base)) lines.push(`- ${escapeMarkdown(line)}`);
  lines.push("", `_Анкета: ${editorUrl}_`, "", `${MARKER_START}${JSON.stringify({ submissions })}${MARKER_END}`);
  return lines.join("\n");
}

/** Список отправок из тела PR (скрытый JSON); пусто, если тела нет или он не наш. */
export function parseQueueBody(body) {
  if (!body) return [];
  const start = body.lastIndexOf(MARKER_START);
  if (start < 0) return [];
  const end = body.indexOf(MARKER_END, start);
  if (end < 0) return [];
  try {
    const data = JSON.parse(body.slice(start + MARKER_START.length, end));
    return Array.isArray(data.submissions) ? data.submissions : [];
  } catch {
    return [];
  }
}
