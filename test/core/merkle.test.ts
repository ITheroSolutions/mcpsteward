import { describe, expect, it } from 'vitest';

import { hashCanonicalForm, type ContentHash } from '../../src/core/canonical.js';
import {
  buildMerkleProof,
  computeSurfaceHashes,
  descriptorKey,
  EMPTY_MERKLE_ROOT,
  merkleLeaf,
  merkleNode,
  merkleRoot,
  verifyMerkleProof,
} from '../../src/core/merkle.js';
import { buildDescriptor, buildDescriptors } from '../../src/core/descriptor.js';
import { parseJsonPreservingNumbers } from '../../src/core/json-parse.js';
import type { JsonValue } from '../../src/core/json-parse.js';

function h(text: string): ContentHash {
  return hashCanonicalForm(text);
}

function parse(text: string): JsonValue {
  return parseJsonPreservingNumbers(text);
}

describe('merkle primitives', () => {
  it('separates leaf and node domains', () => {
    // Without domain separation a leaf whose value happens to equal the
    // concatenation of two child hashes could forge an internal node. This is
    // the RFC 6962 second preimage defence.
    const a = h('a');
    expect(merkleLeaf(a)).not.toBe(merkleNode(a, a));
  });

  it('is order sensitive at a node', () => {
    const a = h('a');
    const b = h('b');
    expect(merkleNode(a, b)).not.toBe(merkleNode(b, a));
  });

  it('produces a well formed hash', () => {
    expect(merkleLeaf(h('a'))).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(merkleNode(h('a'), h('b'))).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe('merkleRoot', () => {
  it('returns the empty root for no leaves', () => {
    expect(merkleRoot([])).toBe(EMPTY_MERKLE_ROOT);
  });

  it('returns the hashed leaf for a single leaf', () => {
    const a = h('a');
    expect(merkleRoot([a])).toBe(merkleLeaf(a));
  });

  it('pairs two leaves', () => {
    const a = h('a');
    const b = h('b');
    expect(merkleRoot([a, b])).toBe(merkleNode(merkleLeaf(a), merkleLeaf(b)));
  });

  it('promotes an odd trailing node rather than duplicating it', () => {
    // Duplicating the last node is the Bitcoin construction and admits a known
    // collision: [a,b,c] and [a,b,c,c] would share a root, so two different
    // descriptor lists could be indistinguishable. Promotion has no such
    // ambiguity, and this test is what keeps it that way.
    const a = h('a');
    const b = h('b');
    const c = h('c');

    expect(merkleRoot([a, b, c])).not.toBe(merkleRoot([a, b, c, c]));
  });

  it('is deterministic', () => {
    const leaves = [h('a'), h('b'), h('c'), h('d'), h('e')];
    expect(merkleRoot(leaves)).toBe(merkleRoot(leaves));
  });

  it('changes when any leaf changes', () => {
    const base = merkleRoot([h('a'), h('b'), h('c')]);
    expect(merkleRoot([h('a'), h('b'), h('z')])).not.toBe(base);
    expect(merkleRoot([h('z'), h('b'), h('c')])).not.toBe(base);
  });

  it('changes when leaves are reordered', () => {
    expect(merkleRoot([h('a'), h('b')])).not.toBe(merkleRoot([h('b'), h('a')]));
  });

  it('changes when a leaf is added or removed', () => {
    const base = merkleRoot([h('a'), h('b')]);
    expect(merkleRoot([h('a'), h('b'), h('c')])).not.toBe(base);
    expect(merkleRoot([h('a')])).not.toBe(base);
  });

  it('handles a range of sizes without collision', () => {
    const roots = new Set<string>();
    for (let size = 0; size <= 33; size += 1) {
      const leaves = Array.from({ length: size }, (_, i) => h(`leaf-${String(i)}`));
      roots.add(merkleRoot(leaves));
    }
    expect(roots.size).toBe(34);
  });
});

describe('inclusion proofs', () => {
  const leaves = Array.from({ length: 7 }, (_, i) => h(`leaf-${String(i)}`));
  const root = merkleRoot(leaves);

  it('verifies for every leaf in an odd sized tree', () => {
    for (let i = 0; i < leaves.length; i += 1) {
      const leaf = leaves[i];
      expect(leaf).toBeDefined();
      const proof = buildMerkleProof(leaves, i);
      expect(verifyMerkleProof(leaf!, proof, root)).toBe(true);
    }
  });

  it('verifies for every leaf across many tree sizes', () => {
    for (let size = 1; size <= 16; size += 1) {
      const set = Array.from({ length: size }, (_, i) => h(`n-${String(i)}`));
      const setRoot = merkleRoot(set);

      for (let i = 0; i < size; i += 1) {
        const proof = buildMerkleProof(set, i);
        expect(verifyMerkleProof(set[i]!, proof, setRoot)).toBe(true);
      }
    }
  });

  it('rejects a proof for the wrong leaf', () => {
    const proof = buildMerkleProof(leaves, 2);
    expect(verifyMerkleProof(h('not-a-real-leaf'), proof, root)).toBe(false);
  });

  it('rejects a proof against the wrong root', () => {
    const proof = buildMerkleProof(leaves, 2);
    expect(verifyMerkleProof(leaves[2]!, proof, h('wrong root'))).toBe(false);
  });

  it('rejects a tampered sibling', () => {
    const proof = buildMerkleProof(leaves, 0);
    const tampered = {
      ...proof,
      siblings: proof.siblings.map((s, i) => (i === 0 ? { ...s, hash: h('tampered') } : s)),
    };
    expect(verifyMerkleProof(leaves[0]!, tampered, root)).toBe(false);
  });

  it('rejects a flipped sibling side', () => {
    const proof = buildMerkleProof(leaves, 1);
    const flipped = {
      ...proof,
      siblings: proof.siblings.map((s) => ({
        ...s,
        side: s.side === 'left' ? ('right' as const) : ('left' as const),
      })),
    };
    expect(verifyMerkleProof(leaves[1]!, flipped, root)).toBe(false);
  });

  it('refuses an out of range index', () => {
    expect(() => buildMerkleProof(leaves, -1)).toThrow(/out of range/);
    expect(() => buildMerkleProof(leaves, 7)).toThrow(/out of range/);
  });
});

describe('computeSurfaceHashes', () => {
  const tools = buildDescriptors('tool', [
    parse('{"name":"get_weather","description":"Gets weather"}'),
    parse('{"name":"search","description":"Searches"}'),
  ]);

  const prompts = buildDescriptors('prompt', [parse('{"name":"summarize"}')]);

  it('produces all three hash levels', () => {
    const hashes = computeSurfaceHashes([...tools, ...prompts]);

    expect(hashes.root).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(hashes.byCategory.tool).toBeDefined();
    expect(hashes.byCategory.prompt).toBeDefined();
    expect(Object.keys(hashes.byDescriptor)).toHaveLength(3);
  });

  it('omits categories the server did not advertise', () => {
    const hashes = computeSurfaceHashes([...tools]);

    // Omission keeps "advertises no prompts" distinguishable from "advertises an
    // empty prompt list", which are different conformance situations.
    expect(hashes.byCategory.prompt).toBeUndefined();
    expect(hashes.byCategory.resource).toBeUndefined();
  });

  it('keys descriptors by category and identity', () => {
    const hashes = computeSurfaceHashes(tools);
    expect(hashes.byDescriptor[descriptorKey('tool', 'get_weather')]).toBe(tools[0]!.hash);
  });

  it('is insensitive to the order the server returned descriptors in', () => {
    // The specification only recommends deterministic ordering from tools/list
    // (MS-TOOL-002 is a SHOULD), so a conforming server may reorder between
    // calls. Treating that as drift would produce constant false alarms.
    const forward = computeSurfaceHashes([...tools, ...prompts]);
    const reversed = computeSurfaceHashes([...prompts, ...tools].reverse());
    expect(reversed.root).toBe(forward.root);
  });

  it('changes the root when a descriptor changes', () => {
    const before = computeSurfaceHashes(tools).root;
    const after = computeSurfaceHashes(
      buildDescriptors('tool', [
        parse('{"name":"get_weather","description":"Gets weather NOW"}'),
        parse('{"name":"search","description":"Searches"}'),
      ]),
    ).root;

    expect(after).not.toBe(before);
  });

  it('changes only the affected category root', () => {
    const before = computeSurfaceHashes([...tools, ...prompts]);
    const after = computeSurfaceHashes([
      ...tools,
      ...buildDescriptors('prompt', [parse('{"name":"summarize","description":"new"}')]),
    ]);

    expect(after.byCategory.tool).toBe(before.byCategory.tool);
    expect(after.byCategory.prompt).not.toBe(before.byCategory.prompt);
    expect(after.root).not.toBe(before.root);
  });

  it('localises a change to a single descriptor hash', () => {
    // This is what makes the merkle structure worth having over a flat digest:
    // a diff can name the descriptor rather than only saying something moved.
    const before = computeSurfaceHashes(tools);
    const after = computeSurfaceHashes(
      buildDescriptors('tool', [
        parse('{"name":"get_weather","description":"changed"}'),
        parse('{"name":"search","description":"Searches"}'),
      ]),
    );

    const weather = descriptorKey('tool', 'get_weather');
    const search = descriptorKey('tool', 'search');

    expect(after.byDescriptor[weather]).not.toBe(before.byDescriptor[weather]);
    expect(after.byDescriptor[search]).toBe(before.byDescriptor[search]);
  });

  it('distinguishes the same descriptor list under a different category', () => {
    const asTool = computeSurfaceHashes(buildDescriptors('tool', [parse('{"name":"x"}')]));
    const asPrompt = computeSurfaceHashes(buildDescriptors('prompt', [parse('{"name":"x"}')]));
    expect(asTool.root).not.toBe(asPrompt.root);
  });

  it('refuses a surface advertising the same identity twice', () => {
    // Which of the two is authoritative is undefined, so there is no honest hash.
    const duplicated = buildDescriptors('tool', [
      parse('{"name":"same","description":"first"}'),
      parse('{"name":"same","description":"second"}'),
    ]);

    expect(() => computeSurfaceHashes(duplicated)).toThrow(/Duplicate descriptor identity/);
  });

  it('handles an entirely empty surface', () => {
    const hashes = computeSurfaceHashes([]);
    expect(hashes.root).toBe(EMPTY_MERKLE_ROOT);
    expect(Object.keys(hashes.byDescriptor)).toHaveLength(0);
  });
});

describe('descriptor identity versus content', () => {
  it('keeps identity stable when the description changes', () => {
    // The split is what lets a description change read as a modification rather
    // than as a removal plus an addition, which is the signal tool poisoning
    // produces and the one this package most needs to surface.
    const before = buildDescriptor('tool', parse('{"name":"run","description":"safe"}'));
    const after = buildDescriptor('tool', parse('{"name":"run","description":"evil"}'));

    expect(after.identity).toBe(before.identity);
    expect(after.hash).not.toBe(before.hash);
  });

  it('reads identity from the right field per category', () => {
    expect(buildDescriptor('tool', parse('{"name":"t"}')).identity).toBe('t');
    expect(buildDescriptor('prompt', parse('{"name":"p"}')).identity).toBe('p');
    expect(buildDescriptor('resource', parse('{"uri":"file:///x"}')).identity).toBe('file:///x');
    expect(
      buildDescriptor('resourceTemplate', parse('{"uriTemplate":"file:///{p}"}')).identity,
    ).toBe('file:///{p}');
  });

  it('refuses a descriptor with no identity', () => {
    // An unnamed tool cannot be pinned, diffed, or named in a finding.
    expect(() => buildDescriptor('tool', parse('{"description":"no name"}'))).toThrow(
      /missing its identity field/,
    );
    expect(() => buildDescriptor('tool', parse('{"name":""}'))).toThrow(
      /missing its identity field/,
    );
  });

  it('refuses a descriptor that is not an object', () => {
    expect(() => buildDescriptor('tool', parse('"just a string"'))).toThrow(
      /must be a JSON object/,
    );
    expect(() => buildDescriptor('tool', parse('[1,2]'))).toThrow(/must be a JSON object/);
  });

  it('hashes identically regardless of field order on the wire', () => {
    const a = buildDescriptor('tool', parse('{"name":"x","description":"d"}'));
    const b = buildDescriptor('tool', parse('{"description":"d","name":"x"}'));
    expect(a.hash).toBe(b.hash);
  });

  it('preserves number fidelity through to the hash', () => {
    // A schema constraint that differs only beyond the double range must still
    // move the hash, or the ledger is blind to it.
    const a = buildDescriptor('tool', parse('{"name":"x","maximum":9007199254740993}'));
    const b = buildDescriptor('tool', parse('{"name":"x","maximum":9007199254740992}'));
    expect(a.hash).not.toBe(b.hash);
  });
});
