import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateQuestion, fold } from '../lib/questions.js';
import { validateCatalog } from '../lib/catalog.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const categories = {
  geography: 'Földrajz', history: 'Történelem', hungary: 'Magyarország', literature: 'Irodalom', art: 'Művészet', music: 'Zene',
  cinema: 'Filmek és sorozatok', sport: 'Sport', animals: 'Állatvilág', plants: 'Növények és természet', body: 'Emberi test',
  physics: 'Fizika és csillagászat', chemistry: 'Kémia', technology: 'Technológia', mathematics: 'Matematika és logika', mythology: 'Mitológia és kultúrák'
};
const createdAt = '2026-10-28T15:43:35.000Z';
const cards = [];
for (const [category, title] of Object.entries(categories)) {
  const filename = path.join(root, 'tools/question-cards', `${category}.txt`);
  if (!fs.existsSync(filename)) { if (process.argv.includes('--partial')) continue; throw new Error(`Missing ${category}`); }
  const lines = fs.readFileSync(filename, 'utf8').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (lines.length !== 50) throw new Error(`${category}: expected 50 cards, got ${lines.length}`);
  for (const [index, line] of lines.entries()) {
    const [question, correct, explanation, group, explicitWrong] = line.split('|').map(value => value.trim());
    if (!question || !correct || !explanation || !group) throw new Error(`${category}:${index + 1} incomplete`);
    cards.push({ category: title, slug: category, question, correct, explanation, group, explicitWrong,
      id: `cg-${category}-${String(index + 1).padStart(3, '0')}`, difficulty: index < 20 ? 'easy' : index < 40 ? 'medium' : 'hard' });
  }
}
const extras = {
  continent: ['Afrika', 'Ázsia', 'Európa', 'Észak-Amerika', 'Dél-Amerika', 'Ausztrália', 'Antarktisz'],
  country: ['Franciaország', 'Spanyolország', 'Olaszország', 'Németország', 'Portugália', 'Görögország', 'Egyiptom', 'India', 'Japán', 'Kína', 'Brazília', 'Kanada', 'Chile', 'Peru', 'Amerikai Egyesült Államok', 'Ausztrália', 'Új-Zéland'],
  city: ['Budapest', 'Bécs', 'Prága', 'Párizs', 'London', 'Róma', 'Athén', 'Tokió', 'Berlin', 'Madrid'],
  river: ['Duna', 'Tisza', 'Rajna', 'Szajna', 'Temze', 'Nílus', 'Amazonas', 'Volga', 'Gangesz', 'Jangce'],
  sea: ['Földközi-tenger', 'Vörös-tenger', 'Fekete-tenger', 'Balti-tenger', 'Északi-tenger', 'Adriai-tenger'],
  ocean: ['Atlanti-óceán', 'Csendes-óceán', 'Indiai-óceán', 'Jeges-tenger', 'Déli-óceán'],
  mountain: ['Alpok', 'Andok', 'Himalája', 'Sziklás-hegység', 'Appalache-hegység', 'Urál', 'Kárpátok', 'Atlasz'],
  lake: ['Balaton', 'Bajkál-tó', 'Viktória-tó', 'Tanganyika-tó', 'Genfi-tó', 'Titicaca-tó'],
  island: ['Grönland', 'Madagaszkár', 'Szicília', 'Izland', 'Kréta', 'Ciprus', 'Tasmánia', 'Bali'],
  number: ['2', '3', '4', '5', '6', '7', '8', '9', '10', '12', '16', '20', '24', '30', '36', '40', '50', '60', '64', '100'],
  direction: ['észak', 'dél', 'kelet', 'nyugat'],
  angle: ['30°', '45°', '60°', '90°', '120°', '180°', '270°', '360°'],
  colour: ['piros', 'kék', 'zöld', 'sárga', 'fehér', 'fekete', 'lila', 'narancssárga'],
  particle: ['elektron', 'proton', 'neutron', 'foton'],
  blood: ['A', 'B', 'AB', '0'],
  unit: ['méter', 'másodperc', 'kilogramm', 'amper', 'kelvin', 'mól', 'kandela', 'newton', 'joule', 'watt', 'pascal', 'hertz'],
  gas: ['oxigén', 'nitrogén', 'szén-dioxid', 'hidrogén', 'hélium', 'argon', 'ózon'],
  season: ['tavasz', 'nyár', 'ősz', 'tél'],
  month: ['január', 'március', 'április', 'május', 'június', 'augusztus', 'szeptember', 'október', 'december'],
  musicnote: ['C', 'D', 'E', 'F', 'G', 'A', 'H'],
  mathunit: ['milliméter', 'centiméter', 'méter', 'kilométer'],
  fraction: ['1/2', '1/3', '1/4', '1/5', '2/3', '3/4', '1/8'],
  musicalform: ['szimfónia', 'szonáta', 'opera', 'oratórium', 'versenymű'],
  chesspiece: ['király', 'vezér', 'bástya', 'futó', 'huszár', 'gyalog'],
  protocol: ['IP', 'TCP', 'UDP', 'SMTP', 'HTTPS'],
  'space-object': ['Nap', 'Hold', 'Plútó', 'Ceres', 'Sirius'],
  acid: ['Ecetsav', 'Citromsav', 'Sósav', 'Foszforsav', 'Kénsav'],
  'norse-god': ['Thor', 'Odin', 'Loki', 'Freyr', 'Tyr'],
  'book-title': ['Iliász', 'Odüsszeia', 'Aeneis', 'Isteni színjáték']
};
const byGroup = new Map();
for (const card of cards) {
  if (!byGroup.has(card.group)) byGroup.set(card.group, [...(extras[card.group] || [])]);
  byGroup.get(card.group).push(card.correct);
}
const rank = (id, value) => createHash('sha256').update(`${id}:${value}`).digest('hex');
const answerKey = value => value.normalize('NFKC').toLocaleLowerCase('hu').replace(/\s+/g, ' ').trim();
const questions = cards.map(card => {
  const options = [...new Map(byGroup.get(card.group).map(value => [answerKey(value), value])).values()].filter(answer => answerKey(answer) !== answerKey(card.correct));
  const wrong = card.explicitWrong ? card.explicitWrong.split('~').map(value => value.trim()) : options.sort((a, b) => rank(card.id, a).localeCompare(rank(card.id, b))).slice(0, 3);
  if (wrong.length !== 3) throw new Error(`${card.id}: group ${card.group} needs more distractors`);
  const validated = validateQuestion({ ...card, wrong });
  return { ...validated, id: card.id, family: ['symbol', 'year'].includes(card.group) ? `${card.slug}-${card.group}` : fold(card.question),
    source: 'chatgpt', status: 'review', createdBy: 'ChatGPT', createdAt, updatedBy: 'ChatGPT', updatedAt: createdAt };
});
const legacy = ['questions.json', 'extra-questions.json'].flatMap(name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'))).map((input, index) => ({ ...validateQuestion(input), id: `legacy-${String(index + 1).padStart(4, '0')}`, status: 'approved', source: 'legacy', createdBy: 'Korábbi bank', createdAt, updatedBy: 'Migráció', updatedAt: createdAt }));
const state = validateCatalog({ schemaVersion: 1, revision: 'seed-3-0-0', questions: [...legacy, ...questions], settings: { backgroundAI: false }, audit: [{ id: 'seed-v3-catalog', at: createdAt, actor: 'ChatGPT', action: 'questions_imported', count: questions.length, detail: 'Új, ellenőrzendő ChatGPT-kérdések; szolgáltatói API-hívás nélkül.' }] });
fs.writeFileSync(path.join(root, 'bank/catalog.json'), `${JSON.stringify(state, null, 2)}\n`);
console.log(JSON.stringify({ total: state.questions.length, approved: legacy.length, newChatGPT: questions.length, categories: Object.fromEntries(Object.values(categories).map(category => [category, questions.filter(q => q.category === category).length])) }));
