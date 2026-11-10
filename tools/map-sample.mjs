#!/usr/bin/env node
// A small invented brain for trying the map, for its tests and for screenshots. Nothing in it is real.
//
//   node tools/map-sample.mjs <folder>                  memories plus index/topics.json (the topic view)
//   node tools/map-sample.mjs <folder> --keyword-only   memories only, as on an install without the meaning model
//
// Then: node tools/dashboard.mjs --brain <folder> --port 8493 --open

import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const NL = String.fromCharCode(10);

// slug, type, name, description, topic, links
const MEMORIES = [
  ['user_profile', 'user', 'About me', 'who I am, what I do, how I like answers written', 0, ['feedback_short_answers', 'project_garden_planner']],
  ['contact_alex_rivera', 'contact', 'Alex Rivera', 'Alex, the designer I work with on the garden planner', 0, ['project_garden_planner']],
  ['contact_sam_okafor', 'contact', 'Sam Okafor', 'Sam, my accountant, invoices and tax deadlines', 0, ['reference_tax_calendar']],
  ['contact_lee_chen', 'contact', 'Lee Chen', 'Lee, runs the community kitchen I volunteer at', 0, ['project_kitchen_rota']],
  ['feedback_short_answers', 'feedback', 'Short answers first', 'answer in one line first, details after, when I ask a question', 1, ['feedback_plain_words']],
  ['feedback_plain_words', 'feedback', 'Plain words', 'no jargon in anything written for me', 1, ['feedback_short_answers']],
  ['feedback_test_before_done', 'feedback', 'Test before saying done', 'run the tests before saying a change works', 1, ['reference_test_commands']],
  ['feedback_ask_before_sending', 'feedback', 'Ask before sending', 'never send an email or message without asking me first', 1, ['contact_alex_rivera']],
  ['feedback_dates_in_full', 'feedback', 'Dates in full', 'write dates as 2026-03-14, never 14/3', 1, ['reference_tax_calendar']],
  ['project_garden_planner', 'project', 'Garden planner app', 'the garden planner app: plots, sowing dates, reminders', 2, ['contact_alex_rivera', 'reference_sowing_table', 'reference_test_commands']],
  ['project_kitchen_rota', 'project', 'Kitchen rota', 'the volunteer rota for the community kitchen, who cooks when', 2, ['contact_lee_chen', 'reference_rota_sheet']],
  ['project_home_budget', 'project', 'Home budget', 'monthly budget spreadsheet, categories and limits', 2, ['reference_tax_calendar', 'contact_sam_okafor']],
  ['project_photo_archive', 'project', 'Photo archive', 'scanning and naming the old family photos', 2, ['reference_naming_scheme']],
  ['project_bike_repair', 'project', 'Bike repair notes', 'fixing the old road bike: parts ordered, what is left', 2, []],
  ['reference_sowing_table', 'reference', 'Sowing table', 'when to sow what, by month, for the garden planner', 3, ['project_garden_planner']],
  ['reference_test_commands', 'reference', 'Test commands', 'how to run the tests of each project', 3, ['project_garden_planner']],
  ['reference_tax_calendar', 'reference', 'Tax calendar', 'tax and invoice deadlines through the year', 3, ['contact_sam_okafor', 'project_home_budget']],
  ['reference_rota_sheet', 'reference', 'Rota sheet', 'where the kitchen rota sheet lives and who can edit it', 3, ['project_kitchen_rota']],
  ['reference_naming_scheme', 'reference', 'Photo naming scheme', 'year, place, people: how scanned photos are named', 3, ['project_photo_archive']],
  ['reference_backup_drive', 'reference', 'Backup drive', 'which drive holds the backups and how often they run', 3, ['project_photo_archive']],
];
const TOPICS = ['People and me', 'How I work', 'Projects', 'Lookups'];

export function writeSample(dir, { keywordOnly = false } = {}) {
  const mem = join(dir, 'memory');
  mkdirSync(mem, { recursive: true });
  for (const [slug, type, name, description, , links] of MEMORIES) {
    const body = ['# ' + name, '', description.charAt(0).toUpperCase() + description.slice(1) + '.', 'An invented memory for the sample brain.',
      ...(links.length ? ['', '## Related', ...links.map((l) => '- [[' + l + ']]')] : [])];
    writeFileSync(join(mem, slug + '.md'), ['---', 'name: ' + name, 'description: ' + description, 'type: ' + type,
      'metadata:', '  type: ' + type, '  asserted: 2026-01-01', '---', '', ...body, ''].join(NL));
  }
  if (!keywordOnly) {
    mkdirSync(join(dir, 'index'), { recursive: true });
    const of = Object.fromEntries(MEMORIES.map((m) => [m[0], m[4]]));
    const topics = TOPICS.map((name, id) => ({ id, name, size: MEMORIES.filter((m) => m[4] === id).length }));
    writeFileSync(join(dir, 'index', 'topics.json'), JSON.stringify({ topics, of }, null, 2));
  }
  return MEMORIES.length;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const dir = process.argv[2];
  if (!dir) { process.stdout.write('usage: node tools/map-sample.mjs <folder> [--keyword-only]' + NL); process.exit(1); }
  const target = resolve(dir);
  if (existsSync(join(target, 'memory')) && readdirSync(join(target, 'memory')).length) {
    process.stdout.write('refusing: ' + join(target, 'memory') + ' already holds files' + NL);
    process.exit(1);
  }
  const n = writeSample(target, { keywordOnly: process.argv.includes('--keyword-only') });
  process.stdout.write('sample brain of ' + n + ' memories in ' + target + NL);
}
