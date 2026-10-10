/**
 * Report renderers.
 *
 * Six formats over one model. Every one is deterministic: the same report renders
 * byte identically every time, and the only field that varies between two runs on
 * identical input is `generatedAt`.
 *
 * The model arrives already redacted, so no renderer needs to remember to do it.
 */

import { allItems, isClean, SEVERITY_ORDER, type Report, type ReportItem } from './model.js';

export * from './model.js';

export type ReportFormat = 'terminal' | 'json' | 'ndjson' | 'markdown' | 'sarif' | 'html';

export const REPORT_FORMATS: readonly ReportFormat[] = [
  'terminal',
  'json',
  'ndjson',
  'markdown',
  'sarif',
  'html',
];

export interface RenderOptions {
  /**
   * Whether to emit ANSI colour.
   *
   * Defaults to false. A renderer that colours by default writes escape codes into
   * every redirected file and CI log, so colour is opt in and the CLI enables it
   * only when stdout is a TTY.
   */
  readonly colour?: boolean;
}

export function render(report: Report, format: ReportFormat, options: RenderOptions = {}): string {
  switch (format) {
    case 'terminal':
      return renderTerminal(report, options);
    case 'json':
      return renderJson(report);
    case 'ndjson':
      return renderNdjson(report);
    case 'markdown':
      return renderMarkdown(report);
    case 'sarif':
      return renderSarif(report);
    case 'html':
      return renderHtml(report);
  }
}

export function isReportFormat(value: string): value is ReportFormat {
  return (REPORT_FORMATS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  grey: '\u001b[90m',
} as const;

const SEVERITY_LABEL: Readonly<Record<string, string>> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
  info: 'INFO',
};

function renderTerminal(report: Report, options: RenderOptions): string {
  const colour = options.colour ?? false;

  const paint = (text: string, code: string): string =>
    colour ? `${code}${text}${ANSI.reset}` : text;

  const severityColour = (severity: string): string => {
    switch (severity) {
      case 'critical':
      case 'high':
        return ANSI.red;
      case 'medium':
        return ANSI.yellow;
      case 'low':
        return ANSI.blue;
      default:
        return ANSI.grey;
    }
  };

  const lines: string[] = [];

  lines.push(paint(report.title, ANSI.bold));
  lines.push(paint(report.subject, ANSI.dim));
  lines.push('');

  for (const item of report.summary) {
    const value =
      item.severity === undefined ? item.value : paint(item.value, severityColour(item.severity));
    lines.push(`  ${item.label.padEnd(28)} ${value}`);
  }

  for (const section of report.sections) {
    lines.push('');
    lines.push(paint(section.title, ANSI.bold));

    if (section.items.length === 0) {
      lines.push(`  ${paint(section.emptyMessage, ANSI.dim)}`);
      continue;
    }

    for (const item of [...section.items].sort(compareItems)) {
      lines.push('');

      const label = paint(
        (SEVERITY_LABEL[item.severity] ?? item.severity).padEnd(8),
        severityColour(item.severity),
      );

      lines.push(`  ${label} ${item.id}  ${item.title}`);

      const where = locusOf(item);
      if (where !== undefined) lines.push(`           ${paint(where, ANSI.dim)}`);

      lines.push(`           ${item.detail}`);

      if (item.remediation !== undefined) {
        lines.push(`           ${paint('Fix:', ANSI.bold)} ${item.remediation}`);
      }
      if (item.citation !== undefined) {
        lines.push(`           ${paint(`Spec: ${item.citation}`, ANSI.dim)}`);
      }
    }
  }

  if (report.notes.length > 0) {
    lines.push('');
    lines.push(paint('Notes', ANSI.bold));
    for (const note of report.notes) lines.push(`  ${paint(note, ANSI.dim)}`);
  }

  lines.push('');
  return lines.join('\n');
}

function locusOf(item: ReportItem): string | undefined {
  if (item.location !== undefined) return `${item.location.file}:${String(item.location.line)}`;
  return item.locus;
}

function compareItems(a: ReportItem, b: ReportItem): number {
  const rank = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
  if (rank !== 0) return rank;

  const byId = a.id.localeCompare(b.id);
  return byId !== 0 ? byId : (locusOf(a) ?? '').localeCompare(locusOf(b) ?? '');
}

// ---------------------------------------------------------------------------
// JSON and NDJSON
// ---------------------------------------------------------------------------

/**
 * Pretty printed JSON of the whole report.
 *
 * Keys are emitted in the order the model declares them, which `JSON.stringify`
 * preserves for object literals, so two runs on identical input produce identical
 * bytes.
 */
function renderJson(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * One JSON object per line.
 *
 * A header line carrying the report metadata, then one line per item. Suited to a
 * log pipeline that reads a line at a time and to `jq` filtering, neither of which
 * wants to parse a multi megabyte document to reach the third finding.
 */
function renderNdjson(report: Report): string {
  const lines: string[] = [
    JSON.stringify({
      type: 'report',
      kind: report.kind,
      title: report.title,
      subject: report.subject,
      generatedAt: report.generatedAt,
      toolVersion: report.toolVersion,
      summary: report.summary,
    }),
  ];

  for (const section of report.sections) {
    for (const item of [...section.items].sort(compareItems)) {
      lines.push(JSON.stringify({ type: 'item', section: section.title, ...item }));
    }
  }

  for (const note of report.notes) {
    lines.push(JSON.stringify({ type: 'note', message: note }));
  }

  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function renderMarkdown(report: Report): string {
  const lines: string[] = [];

  lines.push(`# ${report.title}`);
  lines.push('');
  lines.push(`**Subject:** ${report.subject}  `);
  lines.push(`**Generated:** ${report.generatedAt}  `);
  lines.push(`**mcpsteward:** ${report.toolVersion}`);
  lines.push('');

  if (report.summary.length > 0) {
    lines.push('| Measure | Value |');
    lines.push('| --- | --- |');
    for (const item of report.summary) {
      lines.push(`| ${escapeCell(item.label)} | ${escapeCell(item.value)} |`);
    }
    lines.push('');
  }

  for (const section of report.sections) {
    lines.push(`## ${section.title}`);
    lines.push('');

    if (section.items.length === 0) {
      lines.push(section.emptyMessage);
      lines.push('');
      continue;
    }

    for (const item of [...section.items].sort(compareItems)) {
      lines.push(`### ${item.title}`);
      lines.push('');
      lines.push(`**${(SEVERITY_LABEL[item.severity] ?? item.severity).toLowerCase()}** ` + `\`${item.id}\``);

      const where = locusOf(item);
      if (where !== undefined) lines.push(`**Where:** \`${where}\``);

      lines.push('');
      lines.push(item.detail);
      lines.push('');

      if (item.remediation !== undefined) {
        lines.push(`**Fix:** ${item.remediation}`);
        lines.push('');
      }
      if (item.citation !== undefined) {
        lines.push(`**Specification:** ${item.citation}`);
        lines.push('');
      }
    }
  }

  if (report.notes.length > 0) {
    lines.push('## Notes');
    lines.push('');
    for (const note of report.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

// ---------------------------------------------------------------------------
// SARIF
// ---------------------------------------------------------------------------

/**
 * SARIF 2.1.0, for GitHub code scanning.
 *
 * Items with a file location become results with a physical location, which is
 * what makes a migration finding appear inline on a pull request diff. Items
 * without one still appear, attached to the run rather than to a line, because
 * dropping them would silently hide every conformance and drift finding.
 */
function renderSarif(report: Report): string {
  const rules = new Map<string, ReportItem>();
  for (const item of allItems(report)) {
    if (!rules.has(item.id)) rules.set(item.id, item);
  }

  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'mcpsteward',
            version: report.toolVersion,
            informationUri: 'https://github.com/ITheroSolutions/mcpsteward',
            rules: [...rules.values()].map((item) => ({
              id: item.id,
              name: item.title,
              shortDescription: { text: item.title },
              fullDescription: { text: item.detail },
              defaultConfiguration: { level: sarifLevel(item.severity) },
              ...(item.remediation === undefined
                ? {}
                : { help: { text: item.remediation } }),
              ...(item.citation === undefined
                ? {}
                : { properties: { specification: item.citation } }),
            })),
          },
        },
        results: allItems(report).map((item) => ({
          ruleId: item.id,
          level: sarifLevel(item.severity),
          message: { text: item.detail },
          locations:
            item.location === undefined
              ? []
              : [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: item.location.file },
                      region: { startLine: item.location.line },
                    },
                  },
                ],
          ...(item.locus === undefined
            ? {}
            : { partialFingerprints: { locus: item.locus } }),
        })),
      },
    ],
  };

  return `${JSON.stringify(sarif, null, 2)}\n`;
}

/** SARIF has four levels, so five severities collapse into them. */
function sarifLevel(severity: string): string {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'error';
    case 'medium':
      return 'warning';
    case 'low':
      return 'note';
    default:
      return 'none';
  }
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/**
 * A single file, self contained HTML report.
 *
 * No external stylesheet, no font, no script, no build step. A report that fetches
 * anything is a report that phones home when opened, which would break the promise
 * the rest of the package is built on. It also means the file still renders years
 * later from an archive with no network.
 */
function renderHtml(report: Report): string {
  const rows = report.sections
    .map((section) => {
      if (section.items.length === 0) {
        return `<section><h2>${escapeHtml(section.title)}</h2><p class="empty">${escapeHtml(
          section.emptyMessage,
        )}</p></section>`;
      }

      const items = [...section.items]
        .sort(compareItems)
        .map((item) => {
          const where = locusOf(item);

          return [
            `<article class="item ${escapeHtml(item.severity)}">`,
            `<header><span class="sev">${escapeHtml(SEVERITY_LABEL[item.severity] ?? item.severity)}</span>`,
            `<code>${escapeHtml(item.id)}</code>`,
            `<h3>${escapeHtml(item.title)}</h3></header>`,
            where === undefined ? '' : `<p class="where"><code>${escapeHtml(where)}</code></p>`,
            `<p>${escapeHtml(item.detail)}</p>`,
            item.remediation === undefined
              ? ''
              : `<p class="fix"><strong>Fix:</strong> ${escapeHtml(item.remediation)}</p>`,
            item.citation === undefined
              ? ''
              : `<p class="cite">Specification: ${escapeHtml(item.citation)}</p>`,
            '</article>',
          ].join('');
        })
        .join('');

      return `<section><h2>${escapeHtml(section.title)}</h2>${items}</section>`;
    })
    .join('');

  const summary = report.summary
    .map(
      (item) =>
        `<div class="stat"><span class="label">${escapeHtml(item.label)}</span><span class="value ${escapeHtml(
          item.severity ?? 'none',
        )}">${escapeHtml(item.value)}</span></div>`,
    )
    .join('');

  const notes =
    report.notes.length === 0
      ? ''
      : `<section><h2>Notes</h2><ul>${report.notes
          .map((note) => `<li>${escapeHtml(note)}</li>`)
          .join('')}</ul></section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(report.title)}</title>
<style>
:root { color-scheme: light dark; --fg: #16181d; --bg: #ffffff; --muted: #5b6270; --line: #e3e6ec; --crit: #b3261e; --high: #c2410c; --med: #a16207; --low: #1d4ed8; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6e8ee; --bg: #14161a; --muted: #9aa2b1; --line: #2a2e37; --crit: #ff6b5e; --high: #fb923c; --med: #fbbf24; --low: #7aa2ff; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 2rem 1.25rem 4rem; font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg); background: var(--bg); }
main { max-width: 60rem; margin: 0 auto; }
h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
h2 { font-size: 1.15rem; margin: 2.5rem 0 .75rem; padding-bottom: .4rem; border-bottom: 1px solid var(--line); }
h3 { font-size: 1rem; margin: .35rem 0 0; font-weight: 600; }
.subject { color: var(--muted); margin: 0 0 1.5rem; }
.stats { display: flex; flex-wrap: wrap; gap: .75rem; }
.stat { border: 1px solid var(--line); border-radius: .5rem; padding: .6rem .9rem; min-width: 9rem; }
.stat .label { display: block; font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.stat .value { font-size: 1.35rem; font-weight: 600; }
.item { border: 1px solid var(--line); border-left-width: 4px; border-radius: .5rem; padding: .85rem 1rem; margin: .75rem 0; }
.item.critical { border-left-color: var(--crit); }
.item.high { border-left-color: var(--high); }
.item.medium { border-left-color: var(--med); }
.item.low { border-left-color: var(--low); }
.item.info { border-left-color: var(--line); }
.item header { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
.sev { font-size: .7rem; font-weight: 700; letter-spacing: .06em; }
.critical .sev, .critical .value { color: var(--crit); }
.high .sev, .high .value { color: var(--high); }
.medium .sev, .medium .value { color: var(--med); }
.low .sev, .low .value { color: var(--low); }
.item header h3 { flex-basis: 100%; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .85em; background: color-mix(in srgb, var(--fg) 7%, transparent); padding: .1rem .35rem; border-radius: .25rem; }
p { margin: .5rem 0; }
.where, .cite { color: var(--muted); font-size: .85rem; }
.fix { border-left: 2px solid var(--line); padding-left: .75rem; }
.empty { color: var(--muted); font-style: italic; }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .82rem; }
ul { padding-left: 1.2rem; color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(report.title)}</h1>
<p class="subject">${escapeHtml(report.subject)}</p>
<div class="stats">${summary}</div>
${rows}
${notes}
<footer>Generated ${escapeHtml(report.generatedAt)} by mcpsteward ${escapeHtml(
    report.toolVersion,
  )}. ${isClean(report) ? 'Nothing was found.' : ''} This file is self contained and makes no network requests.</footer>
</main>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
