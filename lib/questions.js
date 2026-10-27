import fs from 'node:fs';
import { randomInt, randomUUID } from 'node:crypto';

export class QuizError extends Error {
  constructor(message, status = 400, code = 'invalid_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const fold = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('hu').replace(/[^a-z0-9]+/g, ' ').trim();
const answerKey = value => String(value).normalize('NFKC').toLocaleLowerCase('hu').replace(/\s+/g, ' ').trim();
export function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function text(value, field, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new QuizError(`Érvénytelen kérdésmező: ${field}.`, 400, 'invalid_question');
  }
  return value.trim();
}

export function validateQuestion(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new QuizError('Érvénytelen kérdés.');
  const category = text(input.category, 'témakör', 80);
  const question = text(input.question, 'kérdés', 360);
  const correct = text(input.correct, 'helyes válasz', 140);
  if (!Array.isArray(input.wrong) || input.wrong.length < 3 || input.wrong.length > 12) throw new QuizError('Legalább három hibás válasz szükséges.');
  const wrong = input.wrong.map(answer => text(answer, 'válasz', 140));
  const answers = [correct, ...wrong].map(answerKey);
  if (new Set(answers).size !== answers.length) throw new QuizError('A válaszoknak különbözniük kell.', 400, 'duplicate_answers');
  const explanation = input.explanation == null ? `A helyes válasz: ${correct}.` : text(input.explanation, 'magyarázat', 700);
  return {
    id: randomUUID(), category, question, correct, wrong, explanation,
    difficulty: ['easy', 'medium', 'hard'].includes(input.difficulty) ? input.difficulty : 'mixed',
    tags: Array.isArray(input.tags) ? input.tags.filter(x => typeof x === 'string').slice(0, 10) : [],
    family: input.family || (question.includes('fővárosa') ? 'capital' : question.includes('vegyjel') ? 'element' : question.includes('egységben mérjük') ? 'unit' : fold(question))
  };
}

export function validatePack(items, expectedCount) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 30 || (expectedCount !== undefined && items.length !== expectedCount)) {
    throw new QuizError(`A kérdéssornak ${expectedCount ?? '1–30'} kérdést kell tartalmaznia.`, 400, 'invalid_pack');
  }
  const questions = items.map(validateQuestion);
  if (new Set(questions.map(q => fold(q.question))).size !== questions.length) throw new QuizError('Ismétlődő kérdések vannak a csomagban.', 400, 'duplicate_questions');
  return questions;
}

export function loadBank() {
  const original = JSON.parse(fs.readFileSync(new URL('../questions.json', import.meta.url), 'utf8'));
  const extra = JSON.parse(fs.readFileSync(new URL('../extra-questions.json', import.meta.url), 'utf8'));
  return [...original, ...extra].map(validateQuestion);
}

export function parseSettings(input = {}) {
  if (input == null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new QuizError('Érvénytelen fordulóbeállítások.');
  const topic = typeof input.topic === 'string' ? input.topic.trim() : '';
  if (topic.length > 120) throw new QuizError('A témakör legfeljebb 120 karakter lehet.');
  const count = Number(input.count ?? 15);
  const timeLimitSec = Number(input.timeLimitSec ?? 10);
  const difficulty = input.difficulty ?? 'mixed';
  if (!Number.isInteger(count) || count < 1 || count > 30) throw new QuizError('A kérdések száma 1 és 30 között legyen.');
  if (![10, 15, 20, 30].includes(timeLimitSec)) throw new QuizError('Válassz 10, 15, 20 vagy 30 másodpercet.');
  if (!['mixed', 'easy', 'medium', 'hard'].includes(difficulty)) throw new QuizError('Érvénytelen nehézség.');
  return { topic: ['altalanos', 'altalanos kviz', 'vegyes'].includes(fold(topic)) ? '' : topic, count, difficulty, timeLimitSec };
}

export function bankPool(bank, settings) {
  const topic = fold(settings.topic);
  const aliases = { tortenelem: 'tortenelem', foldrajz: 'foldrajz', tudomany: 'tudomany', biologia: 'biologia', kultura: 'kultura', sport: 'sport', technologia: 'technologia', filmek: 'filmek', jatekok: 'jatekok' };
  const wanted = aliases[topic] ?? topic;
  return bank.filter(q => {
    const topicMatch = !wanted || fold([q.category, q.question, ...q.tags].join(' ')).includes(wanted);
    const difficultyMatch = settings.difficulty === 'mixed' || q.difficulty === settings.difficulty;
    return topicMatch && difficultyMatch;
  });
}

export function bankPack(bank, settings) {
  const pool = bankPool(bank, settings);
  if (pool.length < settings.count) {
    throw new QuizError(pool.length
      ? `Ehhez a témához és nehézséghez ${pool.length} mentett kérdés van. Csökkentsd a kérdésszámot, válassz vegyes nehézséget, vagy használd az AI-t.`
      : 'Ehhez a témához még nincs mentett kérdéssor. Válassz a felsorolt témákból vagy általános kvízt; egyéni témákhoz az AI-kulcs szükséges.', 422, 'bank_insufficient');
  }
  const selected = [];
  const categories = shuffle([...new Set(pool.map(q => q.category))]);
  const remaining = shuffle(pool);
  const families = new Map();
  // First cover categories and avoid repetitive capital / element / unit templates.
  for (const category of categories) {
    const q = remaining.find(q => q.category === category && !families.has(q.family));
    if (q && selected.length < settings.count) { selected.push(q); families.set(q.family, 1); }
  }
  for (const q of remaining) {
    if (selected.length >= settings.count) break;
    if (!selected.includes(q) && !families.has(q.family)) { selected.push(q); families.set(q.family, 1); }
  }
  for (const q of remaining) {
    if (selected.length >= settings.count) break;
    if (!selected.includes(q)) selected.push(q);
  }
  return shuffle(selected).map(q => ({ ...q, id: randomUUID(), wrong: shuffle(q.wrong).slice(0, 3) }));
}

export function toRoundQuestion(q) {
  const options = shuffle([q.correct, ...shuffle(q.wrong).slice(0, 3)]);
  return { ...q, options, answerIndex: options.indexOf(q.correct) };
}

export function exportQuestions(questions) {
  return questions.map(({ category, question, correct, wrong, explanation, difficulty }) => ({ category, question, correct, wrong, explanation, difficulty }));
}
