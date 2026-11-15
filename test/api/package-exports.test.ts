import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface ExportTarget {
  readonly import?: string;
  readonly types?: string;
}

const manifest = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')) as {
  exports: Record<string, string | ExportTarget>;
};

describe('package exports', () => {
  // 0.1.1 shipped `mcpsteward/protocol` pointing at a module that did not exist,
  // so importing it failed for everyone. Every built entry point must have a
  // source module behind it.
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const entry = typeof target === 'string' ? target : target.import;
    if (!entry?.startsWith('./dist/')) continue;

    it(`${subpath} has a source module`, () => {
      const source = entry.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts');
      expect(existsSync(`${ROOT}${source}`)).toBe(true);
    });
  }

  it('mcpsteward/protocol exposes the client', async () => {
    const protocol = await import('../../src/protocol/index.js');
    expect(typeof protocol.McpClient).toBe('function');
    expect(typeof protocol.StdioTransport).toBe('function');
    expect(typeof protocol.HttpTransport).toBe('function');
  });
});
