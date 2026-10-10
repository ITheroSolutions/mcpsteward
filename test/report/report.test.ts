import { describe, expect, it } from 'vitest';

import {
  buildReport,
  isClean,
  isReportFormat,
  render,
  REPORT_FORMATS,
  type Report,
} from '../../src/report/index.js';

const SECRETS = {
  github: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
  anthropic: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
  bearer: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijklmnop',
  connection: 'postgres://svc:hunter2hunter2@db.internal:5432/app',
  aws: 'AKIAIOSFODNN7EXAMPLE',
} as const;

function sample(overrides: Partial<Parameters<typeof buildReport>[0]> = {}): Report {
  return buildReport({
    kind: 'conformance',
    title: 'Conformance report',
    subject: 'fixture-server',
    toolVersion: '0.1.0',
    generatedAt: '2026-08-04T00:00:00.000Z',
    summary: [
      { label: 'Grade', value: 'C', severity: 'high' },
      { label: 'Rules run', value: '14' },
    ],
    sections: [
      {
        title: 'Findings',
        emptyMessage: 'No findings.',
        items: [
          {
            id: 'MS-LIFE-001',
            title: 'server/discover is implemented',
            severity: 'critical',
            detail: 'server/discover answered method not found.',
            remediation: 'Add a server/discover handler returning supportedVersions.',
            citation: 'basic/versioning#protocol-version-negotiation',
            locus: 'server/discover',
          },
          {
            id: 'MS-CACHE-002',
            title: 'ttlMs is a non negative integer',
            severity: 'medium',
            detail: 'One result carried a negative ttlMs.',
            location: { file: 'src/handlers.ts', line: 42 },
          },
        ],
      },
      { title: 'Passed', emptyMessage: 'Nothing passed.', items: [] },
    ],
    notes: ['minimumGrade was not evaluated because no grades were supplied.'],
    ...overrides,
  });
}

describe('every format renders', () => {
  for (const format of REPORT_FORMATS) {
    it(`produces non empty output for ${format}`, () => {
      const output = render(sample(), format);
      expect(output.length).toBeGreaterThan(50);
    });

    it(`includes the finding id in ${format}`, () => {
      expect(render(sample(), format)).toContain('MS-LIFE-001');
    });
  }

  it('knows its own format names', () => {
    for (const format of REPORT_FORMATS) expect(isReportFormat(format)).toBe(true);
    expect(isReportFormat('yaml')).toBe(false);
  });
});

describe('redaction reaches every renderer', () => {
  // Exactly the test that matters: plant secrets, run them through every
  // renderer, assert none appear anywhere.
  const planted = sample({
    subject: `server ${SECRETS.github}`,
    title: `Report for ${SECRETS.aws}`,
    summary: [{ label: `key ${SECRETS.anthropic}`, value: SECRETS.github }],
    sections: [
      {
        title: `Findings for ${SECRETS.github}`,
        emptyMessage: `none for ${SECRETS.anthropic}`,
        items: [
          {
            id: 'MS-TEST-001',
            title: `tool leaking ${SECRETS.github}`,
            severity: 'critical',
            detail: `The server sent ${SECRETS.anthropic} in a description.`,
            remediation: `Rotate ${SECRETS.github} immediately.`,
            locus: SECRETS.aws,
            citation: `see ${SECRETS.github}`,
            location: { file: `src/${SECRETS.github}.ts`, line: 1 },
            evidence: { [`header ${SECRETS.bearer}`]: SECRETS.connection },
          },
        ],
      },
    ],
    notes: [`connection was ${SECRETS.connection}`],
  });

  for (const format of REPORT_FORMATS) {
    it(`emits no planted secret in ${format}`, () => {
      const output = render(planted, format);

      for (const [name, secret] of Object.entries(SECRETS)) {
        // The connection string is only a credential in position, so the
        // password alone is what must not survive.
        const needle = name === 'connection' ? 'hunter2hunter2' : secret;
        expect(output, `${name} leaked into ${format}`).not.toContain(needle);
      }
    });
  }

  it('redacts once at build time rather than in each renderer', () => {
    // If redaction lived in the renderers there would be six chances to forget.
    expect(JSON.stringify(planted)).not.toContain(SECRETS.github);
  });

  it('still marks that something was removed', () => {
    expect(render(planted, 'terminal')).toContain('REDACTED');
  });
});

describe('determinism', () => {
  for (const format of REPORT_FORMATS) {
    it(`renders ${format} byte identically on repeat`, () => {
      expect(render(sample(), format)).toBe(render(sample(), format));
    });
  }

  it('differs only in the timestamp between two runs on identical input', () => {
    const a = render(sample({ generatedAt: '2026-08-04T00:00:00.000Z' }), 'json');
    const b = render(sample({ generatedAt: '2026-08-05T11:22:33.000Z' }), 'json');

    expect(a).not.toBe(b);
    expect(a.replace('2026-08-04T00:00:00.000Z', 'X')).toBe(
      b.replace('2026-08-05T11:22:33.000Z', 'X'),
    );
  });

  it('sorts items most severe first, regardless of input order', () => {
    const forward = render(sample(), 'markdown');

    const reversed = sample({
      sections: [
        {
          title: 'Findings',
          emptyMessage: 'No findings.',
          items: [
            {
              id: 'MS-CACHE-002',
              title: 'ttlMs is a non negative integer',
              severity: 'medium',
              detail: 'One result carried a negative ttlMs.',
              location: { file: 'src/handlers.ts', line: 42 },
            },
            {
              id: 'MS-LIFE-001',
              title: 'server/discover is implemented',
              severity: 'critical',
              detail: 'server/discover answered method not found.',
              remediation: 'Add a server/discover handler returning supportedVersions.',
              citation: 'basic/versioning#protocol-version-negotiation',
              locus: 'server/discover',
            },
          ],
        },
        { title: 'Passed', emptyMessage: 'Nothing passed.', items: [] },
      ],
    });

    expect(render(reversed, 'markdown')).toBe(forward);
  });
});

describe('terminal renderer', () => {
  it('emits no ANSI escapes by default', () => {
    // A renderer that colours by default writes escape codes into every
    // redirected file and CI log.
    expect(render(sample(), 'terminal')).not.toContain('\u001b[');
  });

  it('emits colour when explicitly asked', () => {
    expect(render(sample(), 'terminal', { colour: true })).toContain('\u001b[');
  });

  it('renders the same content with and without colour, once codes are stripped', () => {
    const plain = render(sample(), 'terminal');
    // eslint-disable-next-line no-control-regex
    const stripped = render(sample(), 'terminal', { colour: true }).replace(/\u001b\[\d+m/g, '');
    expect(stripped).toBe(plain);
  });

  it('shows the empty message for a section with no items', () => {
    expect(render(sample(), 'terminal')).toContain('Nothing passed.');
  });

  it('shows the remediation and the citation', () => {
    const output = render(sample(), 'terminal');
    expect(output).toContain('Fix:');
    expect(output).toContain('basic/versioning');
  });

  it('shows a file location when the item has one', () => {
    expect(render(sample(), 'terminal')).toContain('src/handlers.ts:42');
  });
});

describe('json and ndjson', () => {
  it('produces parseable JSON', () => {
    expect(() => {
      JSON.parse(render(sample(), 'json'));
    }).not.toThrow();
  });

  it('produces one parseable object per NDJSON line', () => {
    const lines = render(sample(), 'ndjson').trim().split('\n');

    for (const line of lines) {
      expect(() => {
        JSON.parse(line);
      }).not.toThrow();
    }

    const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types[0]).toBe('report');
    expect(types).toContain('item');
    expect(types).toContain('note');
  });

  it('keeps every item in NDJSON', () => {
    const items = render(sample(), 'ndjson')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string })
      .filter((o) => o.type === 'item');

    expect(items).toHaveLength(2);
  });
});

describe('markdown', () => {
  it('escapes a pipe so a table cell cannot break the table', () => {
    const report = sample({
      summary: [{ label: 'weird | label', value: 'a | b' }],
    });

    expect(render(report, 'markdown')).toContain('weird \\| label');
  });

  it('renders headings for each section', () => {
    const output = render(sample(), 'markdown');
    expect(output).toContain('## Findings');
    expect(output).toContain('## Passed');
  });
});

describe('sarif', () => {
  it('produces valid SARIF 2.1.0 structure', () => {
    const sarif = JSON.parse(render(sample(), 'sarif')) as {
      version: string;
      runs: { tool: { driver: { name: string; rules: unknown[] } }; results: unknown[] }[];
    };

    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0]?.tool.driver.name).toBe('mcpsteward');
    expect(sarif.runs[0]?.tool.driver.rules.length).toBeGreaterThan(0);
  });

  it('attaches a physical location when the item has a file and line', () => {
    // This is what makes a migration finding appear inline on a pull request.
    const sarif = JSON.parse(render(sample(), 'sarif')) as {
      runs: {
        results: { ruleId: string; locations: { physicalLocation?: unknown }[] }[];
      }[];
    };

    const withLocation = sarif.runs[0]?.results.find((r) => r.ruleId === 'MS-CACHE-002');
    expect(withLocation?.locations[0]).toHaveProperty('physicalLocation');
  });

  it('still emits items that have no file location', () => {
    // Dropping them would silently hide every conformance and drift finding.
    const sarif = JSON.parse(render(sample(), 'sarif')) as {
      runs: { results: { ruleId: string }[] }[];
    };

    expect(sarif.runs[0]?.results.map((r) => r.ruleId)).toContain('MS-LIFE-001');
  });

  it('maps five severities onto the four SARIF levels', () => {
    const sarif = JSON.parse(render(sample(), 'sarif')) as {
      runs: { results: { ruleId: string; level: string }[] }[];
    };

    const levels = new Map(sarif.runs[0]?.results.map((r) => [r.ruleId, r.level]));
    expect(levels.get('MS-LIFE-001')).toBe('error');
    expect(levels.get('MS-CACHE-002')).toBe('warning');
  });
});

describe('html', () => {
  it('is a complete self contained document', () => {
    const html = render(sample(), 'html');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
  });

  it('references nothing external', () => {
    // A report that fetches anything phones home when opened, which would break
    // the promise the rest of the package is built on.
    const html = render(sample(), 'html');

    expect(html).not.toMatch(/<script\s+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/https?:\/\/(?!json\.schemastore)/);
    expect(html).not.toContain('@import');
  });

  it('carries its styles inline', () => {
    expect(render(sample(), 'html')).toContain('<style>');
  });

  it('escapes HTML so a server cannot inject markup through a tool name', () => {
    const report = sample({
      sections: [
        {
          title: 'Findings',
          emptyMessage: 'none',
          items: [
            {
              id: 'X',
              title: '<script>alert(1)</script>',
              severity: 'low',
              detail: 'a "quoted" & <dangerous> value',
            },
          ],
        },
      ],
    });

    const html = render(report, 'html');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });

  it('states that it makes no network requests', () => {
    expect(render(sample(), 'html')).toContain('no network requests');
  });
});

describe('report model', () => {
  it('reports a clean report as clean', () => {
    const clean = sample({
      sections: [{ title: 'Findings', emptyMessage: 'No findings.', items: [] }],
    });

    expect(isClean(clean)).toBe(true);
    expect(isClean(sample())).toBe(false);
  });

  it('renders notes separately from findings', () => {
    // A note is not a problem, and mixing them would inflate the apparent
    // finding count.
    const output = render(sample(), 'terminal');
    expect(output).toContain('Notes');
    expect(output).toContain('minimumGrade was not evaluated');
  });

  it('defaults the timestamp when none is supplied', () => {
    const report = buildReport({
      kind: 'inventory',
      title: 't',
      subject: 's',
      toolVersion: '0.1.0',
      summary: [],
      sections: [],
    });

    expect(Date.parse(report.generatedAt)).not.toBeNaN();
  });
});

describe('format coverage', () => {
  it('renders every declared format without a missing case', () => {
    // The switch in render() is exhaustive over ReportFormat, so a new format
    // added to the union without a case is a compile error. This asserts the
    // list and the switch agree at runtime too.
    for (const format of REPORT_FORMATS) {
      expect(() => render(sample(), format)).not.toThrow();
    }
  });
});
