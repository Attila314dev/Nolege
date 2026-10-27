import assert from 'node:assert/strict';
import test from 'node:test';
import { bankPack, bankPool, loadBank, parseSettings, validatePack, validateQuestion, toRoundQuestion } from '../lib/questions.js';

const bank = loadBank();
test('the full fallback bank is valid and contains useful explanations', () => {
  assert.equal(bank.length, 140);
  assert.ok(bank.every(q => q.explanation.length > 10 && q.wrong.length >= 3));
  assert.ok(bankPool(bank, parseSettings({ topic: 'Harry Potter' })).length >= 15);
});
test('general quiz selection covers categories without repetitive templates', () => {
  for (let attempt = 0; attempt < 40; attempt++) {
    const pack = bankPack(bank, parseSettings());
    assert.equal(pack.length, 15);
    assert.equal(new Set(pack.map(q => q.question)).size, 15);
    assert.ok(new Set(pack.map(q => q.category)).size >= 8);
    for (const family of ['capital', 'element', 'unit', 'harry-potter']) assert.ok(pack.filter(q => q.family === family).length <= 1);
  }
});
test('exact count, topic and difficulty filters are respected', () => {
  for (const count of [1, 5, 15, 30]) assert.equal(bankPack(bank, parseSettings({ count })).length, count);
  const pack = bankPack(bank, parseSettings({ topic: 'Harry Potter', count: 15 }));
  assert.ok(pack.every(q => q.tags.includes('Harry Potter')));
  assert.throws(() => bankPack(bank, parseSettings({ topic: 'nincs ilyen téma', count: 1 })), /még nincs/);
  const hard = bankPack(bank, parseSettings({ difficulty: 'hard', count: 5 }));
  assert.ok(hard.every(q => q.difficulty === 'hard'));
  for (const count of [0, -1, 31, 1.5, 'abc']) assert.throws(() => parseSettings({ count }));
});
test('validation rejects ambiguous duplicate choices but preserves C++ and C# as distinct answers', () => {
  const q = { category: 'Teszt', question: 'Kérdés?', correct: 'JavaScript', wrong: ['C++', 'C#', 'Python'], explanation: 'Rövid magyarázat.' };
  assert.doesNotThrow(() => validateQuestion(q));
  assert.throws(() => validateQuestion({ ...q, wrong: ['JavaScript', 'Python', 'Ruby'] }), /különbözniük/);
  assert.throws(() => validatePack([q, q]), /Ismétlődő/);
  const round = toRoundQuestion(validateQuestion(q));
  assert.equal(round.options.length, 4);
  assert.equal(round.options[round.answerIndex], q.correct);
});
