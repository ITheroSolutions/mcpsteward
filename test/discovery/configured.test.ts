/**
 * Starting a server with what its own configuration supplies.
 *
 * Found by running mcpsteward against a real machine: servers exited saying a
 * variable was not set, although their configurations set it. Only the names were recorded, and the values
 * were looked up in mcpsteward's own environment instead.
 */

import { describe, expect, it } from 'vitest';

import type { ServerRef } from '../../src/core/types.js';
import type { ClientDefinition } from '../../src/discovery/clients.js';
import {
  environmentNamesFor,
  launchSettingsFor,
  resolvePlaceholders,
} from '../../src/discovery/configured.js';
import { deduplicate, parseClientConfig } from '../../src/discovery/parse.js';

const CLIENT: ClientDefinition = {
  id: 'claude-code',
  displayName: 'Claude Code',
  shape: 'mcpServers',
  confidence: 'confirmed',
  paths: [],
};

function inventoried(entry: Record<string, unknown>): ServerRef {
  const text = JSON.stringify({ mcpServers: { srv: entry } });
  const [server] = deduplicate(parseClientConfig(text, CLIENT, '/cfg.json'));
  if (server === undefined) throw new Error('fixture parsed to nothing');
  return server;
}

describe('resolvePlaceholders', () => {
  const env = { HOME_DIR: '/home/dev', USERPROFILE: 'C:\\Users\\dev', token: 't0k' };

  it('passes a plain value through', () => {
    expect(resolvePlaceholders('C:\\notes', env).value).toBe('C:\\notes');
  });

  it('fills ${env:NAME}, as VS Code and Cursor write it', () => {
    expect(resolvePlaceholders('${env:HOME_DIR}/vault', env).value).toBe('/home/dev/vault');
  });

  it('fills ${NAME} and ${NAME:-default}, as Claude Code writes it', () => {
    expect(resolvePlaceholders('${HOME_DIR}', env).value).toBe('/home/dev');
    expect(resolvePlaceholders('${MISSING:-fallback}', env).value).toBe('fallback');
  });

  it('fills ${userHome}', () => {
    expect(resolvePlaceholders('${userHome}\\x', env).value).toBe('C:\\Users\\dev\\x');
  });

  it('looks names up case insensitively, as Windows does', () => {
    expect(resolvePlaceholders('${env:TOKEN}', env).value).toBe('t0k');
  });

  it('refuses the whole value when any placeholder cannot be filled', () => {
    const result = resolvePlaceholders('Bearer ${input:api_key}', env);
    expect(result.value).toBeUndefined();
    expect(result.unresolved).toEqual(['${input:api_key}']);

    expect(resolvePlaceholders('${env:NOPE}', env).value).toBeUndefined();
    expect(resolvePlaceholders('${workspaceFolder}/x', env).value).toBeUndefined();
  });
});

describe('launchSettingsFor', () => {
  it('gives a server the environment values from its own configuration', () => {
    const server = inventoried({
      command: 'notes-server',
      env: { DATA_DIR: 'C:\\data', API_KEY: '${env:SERVICE_TOKEN}' },
    });

    const settings = launchSettingsFor(server, { SERVICE_TOKEN: 'from-operator' });
    expect(settings.env).toEqual({ DATA_DIR: 'C:\\data', API_KEY: 'from-operator' });
  });

  it('never gives it anything its configuration does not name', () => {
    const server = inventoried({ command: 'x', env: { A: '1' } });
    const settings = launchSettingsFor(server, { GITHUB_TOKEN: 'ghp_secret', A: 'ignored' });
    expect(settings.env).toEqual({ A: '1' });
  });

  it('falls back to the operator environment for a name whose value cannot be filled', () => {
    const server = inventoried({ command: 'x', env: { KEY: '${input:key}' } });
    expect(launchSettingsFor(server, { KEY: 'from-shell' }).env).toEqual({ KEY: 'from-shell' });
    expect(launchSettingsFor(server, {}).env).toEqual({});
  });

  it('lets explicitly passed variables win', () => {
    const server = inventoried({ command: 'x', env: { MODE: 'config' } });
    expect(launchSettingsFor(server, {}, { MODE: 'explicit' }).env['MODE']).toBe('explicit');
  });

  it('fills placeholders in arguments', () => {
    const server = inventoried({ command: 'srv', args: ['--root', '${env:ROOT}'] });
    expect(launchSettingsFor(server, { ROOT: '/data' }).args).toEqual(['--root', '/data']);
  });

  it('refuses to start a server whose argument only its own client can fill', () => {
    const server = inventoried({
      command: 'uv',
      args: ['--directory', '${input:server_source_dir}', 'run', 'server.py'],
    });
    expect(() => launchSettingsFor(server, {})).toThrow(
      /only the client that owns this configuration/,
    );
  });

  it('gives an HTTP server its configured headers', () => {
    const server = inventoried({
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer ${env:EXAMPLE_TOKEN}', 'X-Static': 'yes' },
    });

    expect(launchSettingsFor(server, { EXAMPLE_TOKEN: 'abc' }).headers).toEqual({
      Authorization: 'Bearer abc',
      'X-Static': 'yes',
    });
  });

  it('works without configured values for a ServerRef built by hand', () => {
    const server: ServerRef = {
      id: 'x',
      name: 'x',
      endpoint: { transport: 'stdio', command: 'x', args: ['a'], envNames: ['MODE'] },
      authPosture: 'none',
      registrations: [],
    };
    expect(launchSettingsFor(server, { MODE: 'from-shell' })).toMatchObject({
      args: ['a'],
      env: { MODE: 'from-shell' },
    });
  });
});

describe('environmentNamesFor', () => {
  it('lists the names placeholders read, and nothing a value already supplies', () => {
    const server = inventoried({
      command: 'srv',
      args: ['--root', '${env:ROOT}', '--home', '${userHome}'],
      env: { DATA_DIR: 'C:\\data', API_KEY: '${env:SERVICE_TOKEN}', MODE: '${MODE:-fast}' },
    });

    expect(environmentNamesFor(server)).toEqual([
      'HOME',
      'MODE',
      'ROOT',
      'SERVICE_TOKEN',
      'USERPROFILE',
    ]);
  });

  it('leaves out a configured name filled from other variables, so the host cannot override it', () => {
    const server = inventoried({
      command: 'x',
      env: { API_KEY: '${env:SERVICE_TOKEN}' },
    });

    const names = environmentNamesFor(server);
    expect(names).toEqual(['SERVICE_TOKEN']);

    // Passing exactly those names gives the server what its configuration says,
    // even when the host also has a variable called API_KEY.
    const host = { SERVICE_TOKEN: 'from-config', API_KEY: 'from-host' };
    const passed = Object.fromEntries(names.map((name) => [name, host[name as keyof typeof host]]));
    expect(launchSettingsFor(server, passed, passed).env).toEqual({
      API_KEY: 'from-config',
      SERVICE_TOKEN: 'from-config',
    });
  });

  it('includes a name whose value only its own client can fill, since it is looked up instead', () => {
    const server = inventoried({ command: 'x', env: { KEY: '${input:key}' } });
    expect(environmentNamesFor(server)).toEqual(['KEY']);
  });

  it('does not report variables the editor fills itself, such as ${workspaceFolder}', () => {
    const server = inventoried({
      command: 'x',
      args: ['--root', '${workspaceFolder}'],
      env: { DATA: '${workspaceFolder}/data' },
    });
    // DATA is looked up by its own name, since the editor variable cannot be
    // filled here; workspaceFolder itself is never treated as an environment name.
    expect(environmentNamesFor(server)).toEqual(['DATA']);
  });

  it('reads the placeholders in an HTTP server headers', () => {
    const server = inventoried({
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer ${env:EXAMPLE_TOKEN}', 'X-Static': 'yes' },
    });
    expect(environmentNamesFor(server)).toEqual(['EXAMPLE_TOKEN']);
  });

  it('returns every listed name for a ServerRef built by hand', () => {
    const server: ServerRef = {
      id: 'x',
      name: 'x',
      endpoint: { transport: 'stdio', command: 'x', args: [], envNames: ['B', 'A'] },
      authPosture: 'none',
      registrations: [],
    };
    expect(environmentNamesFor(server)).toEqual(['A', 'B']);
  });
});

describe('configured values stay out of everything that is serialised', () => {
  it('never appear in the ServerRef or its JSON', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
    const server = inventoried({
      command: 'srv',
      env: { OPENAI_API_KEY: secret },
    });

    expect(JSON.stringify(server)).not.toContain(secret);
    expect(Object.values(server.endpoint).flat()).not.toContain(secret);
    // Yet the server itself still receives it.
    expect(launchSettingsFor(server, {}).env['OPENAI_API_KEY']).toBe(secret);
  });
});
