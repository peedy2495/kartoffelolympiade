import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';

// Only assistant text events are eligible; tool output and reasoning are not reports.
const [eventsPath, reportPath] = process.argv.slice(2);
let lastText;
try {
  for (const line of readFileSync(eventsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type === 'text' && event.part?.type === 'text' && typeof event.part.text === 'string') {
      lastText = event.part.text;
    }
  }
} catch {
  process.exit(1);
}
const report = lastText?.replace(/\r\n/g, '\n').trim();
const headings = ['Status', 'Implemented', 'Changed Files', 'Verification', 'Plan Deviations', 'Blockers'];
if (!report?.startsWith('# Status\n')) process.exit(1);
const sections = report.split(/^# /m).slice(1);
if (sections.length !== headings.length) process.exit(1);
const bodies = sections.map((section, index) => {
  const newline = section.indexOf('\n');
  if (section.slice(0, newline) !== headings[index]) process.exit(1);
  const body = section.slice(newline + 1).trim();
  if (!body) process.exit(1);
  return body;
});
if (!['SUCCESS', 'PARTIAL', 'BLOCKED'].includes(bodies[0])) process.exit(1);
if (bodies.slice(1).some((body) => !body.startsWith('- '))) process.exit(1);
const temporary = `${reportPath}.recovered-${process.pid}`;
try {
  writeFileSync(temporary, `${report}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, reportPath);
} finally {
  rmSync(temporary, { force: true });
}
