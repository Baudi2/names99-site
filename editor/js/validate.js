// Проверки до отправки (D-030, AC-8) — подсказки редактору на языке правил
// приложения; гейт остаётся в CI (build_bundle.py) и в самом приложении
// (ContentValidator.kt). Правила — те же, что там; правка — в трёх местах.
import { COLLECTIONS, ENTRY_FIELDS, LABELS, NAME_FIELDS } from "./content.js";

export const TOTAL_NAMES = 99;
const TEXT_KEY = /^[a-z0-9_.-]{1,64}$/;
const MAX_TEXT_BYTES = 20 * 1024;
// Все формы слова «имя» со строчной, с кириллическими границами слова (D-026).
const LOWER_NAME_WORD = /(?<![а-яё])(имя|имени|именем|имена|имён|именам|именами|именах)(?![а-яё])/u;
// Те же диапазоны, что в ContentTextHygiene.kt и build_bundle.py.
const INVISIBLE =
  /[\u{ad}\u{feff}\u{61c}\u{180e}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{206f}\u{2028}\u{2029}\u{fe00}-\u{fe0f}\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f\u{e0000}-\u{e007f}]/u;
const WORD = /\p{L}+/gu;
const CYRILLIC =
  /[\u{400}-\u{4ff}]/u;
const LATIN = /[A-Za-z]/;
const LATIN_NOT_PALOCHKA = /[A-HJ-Za-km-z]/; // латиница без l и I (палочка, D-025)
const NON_ARABIC =
  /[^ \u{a0}.,;:!?()[\]«»"'\-–—…0-9\u{600}-\u{6ff}\u{750}-\u{77f}\u{8a0}-\u{8ff}\u{fb50}-\u{fdff}\u{fe70}-\u{fefe}]/u;

export function hygieneProblems(where, text, { arabic = false, allowPalochka = false } = {}) {
  const problems = [];
  if (text.normalize("NFC") !== text) problems.push(`${where}: текст не в форме NFC (форма нормализует при вводе)`);
  if (INVISIBLE.test(text)) problems.push(`${where}: невидимый или форматный символ`);
  if (arabic) {
    if (NON_ARABIC.test(text)) problems.push(`${where}: в арабском поле есть не арабская буква`);
  } else {
    const latin = allowPalochka ? LATIN_NOT_PALOCHKA : LATIN;
    for (const word of text.match(WORD) || []) {
      if (CYRILLIC.test(word) && latin.test(word)) problems.push(`${where}: в слове «${word}» смешаны кириллица и латиница`);
    }
  }
  return problems;
}

const blank = (value) => String(value ?? "").trim() === "";
const utf8Bytes = (text) => new TextEncoder().encode(text).length;

/** { errors, warnings } по-русски — как build_bundle.py. */
export function validateContent(content) {
  const errors = [];
  const warnings = [];
  const names = content.names;
  if (names.length !== TOTAL_NAMES) errors.push(`Имён должно быть ${TOTAL_NAMES}, а в файле ${names.length}`);
  for (const name of names) {
    const where = `Имя ${name.id}`;
    for (const field of [...NAME_FIELDS, "audioFile"]) {
      if (blank(name[field])) errors.push(`${where}: пустое поле «${LABELS.field[field] || field}»`);
    }
    for (const field of ["meaning", "translation"]) {
      if (LOWER_NAME_WORD.test(String(name[field] ?? ""))) {
        warnings.push(`${where}, ${LABELS.field[field]}: слово «имя» со строчной — по правилу D-026 нужна заглавная`);
      }
    }
    errors.push(...hygieneProblems(`${where}, арабский`, String(name.arabic ?? ""), { arabic: true }));
    for (const field of ["transliteration", "translation", "meaning"]) {
      errors.push(...hygieneProblems(`${where}, ${LABELS.field[field]}`, String(name[field] ?? "")));
    }
  }
  if (content.chechen.size > 0) {
    const ids = [...content.chechen.keys()].sort((a, b) => a - b);
    const expected = names.map((name) => name.id).sort((a, b) => a - b);
    if (JSON.stringify(ids) !== JSON.stringify(expected)) {
      errors.push("Чеченская транслитерация должна быть у всех 99 Имён или ни у одного");
    }
    for (const [id, value] of content.chechen) {
      if (blank(value)) errors.push(`Имя ${id}: пустая чеченская транслитерация`);
      errors.push(...hygieneProblems(`Имя ${id}, чеченская транслитерация`, String(value ?? ""), { allowPalochka: true }));
    }
  }
  for (const [key, value] of content.texts) {
    const where = `Текст ${LABELS.text[key] || key}`;
    if (!TEXT_KEY.test(key)) errors.push(`${where}: недопустимый ключ «${key}»`);
    if (blank(value)) errors.push(`${where}: пусто — удалите текст, чтобы приложение показало встроенный`);
    if (utf8Bytes(value) > MAX_TEXT_BYTES) errors.push(`${where}: длиннее 20 КБ`);
    if (LOWER_NAME_WORD.test(value)) errors.push(`${where}: слово «имя» со строчной — об Именах Аллаха пишем с заглавной (D-026)`);
    errors.push(...hygieneProblems(where, value));
  }
  for (const collection of COLLECTIONS) {
    const list = content.collections[collection];
    const ids = list.map((entry) => entry.id);
    if (new Set(ids).size !== ids.length) errors.push(`${LABELS.collection[collection]}: повторяющиеся id`);
    for (const entry of list) {
      const where = `${LABELS.collection[collection]}, запись ${entry.id}`;
      if (blank(entry.id)) errors.push(`${LABELS.collection[collection]}: запись без id`);
      for (const field of ["arabic", "translation"]) {
        if (blank(entry[field])) errors.push(`${where}: пустое поле «${LABELS.field[field]}»`);
      }
      if ((entry.nameIds || []).some((n) => !Number.isInteger(n) || n < 1 || n > TOTAL_NAMES)) {
        errors.push(`${where}: связанное Имя вне 1..99`);
      }
      for (const field of ["translation", "note"]) {
        if (LOWER_NAME_WORD.test(String(entry[field] ?? ""))) {
          errors.push(`${where}, ${LABELS.field[field]}: слово «имя» со строчной (D-026)`);
        }
      }
      errors.push(...hygieneProblems(`${where}, арабский`, String(entry.arabic ?? ""), { arabic: true }));
      for (const field of ENTRY_FIELDS.filter((f) => f !== "arabic")) {
        errors.push(...hygieneProblems(`${where}, ${LABELS.field[field]}`, String(entry[field] ?? "")));
      }
    }
  }
  return { errors, warnings };
}
