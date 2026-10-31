import fs from 'node:fs';
import { validateQuestion } from '../lib/questions.js';

// A fixed test fixture; live admin approvals do not change exhaustion scenarios.
export const legacyBank = ['questions.json', 'extra-questions.json'].flatMap(name =>
  JSON.parse(fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'))).map(validateQuestion);
