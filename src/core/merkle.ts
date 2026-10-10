/**
 * Merkle hashing over a server surface.
 *
 * Three levels: per descriptor, per category, and a root
 * over the whole surface. The point of the tree rather than a flat digest is that
 * a diff can say *which* descriptor changed, and an inclusion proof can show that
 * a specific tool definition was present in a specific ledger entry without
 * republishing the whole surface.
 *
 * ## Domain separation
 *
 * Leaves are hashed with a `0x00` prefix and internal nodes with `0x01`. Without
 * this, an attacker who controls a leaf value could supply a value that is itself
 * the concatenation of two child hashes, producing a tree that verifies against a
 * root it should not. This is the standard second preimage attack on Merkle trees,
 * described in RFC 6962 section 2.1, and the prefixes are the standard defence.
 *
 * ## Odd node counts
 *
 * An odd node at the end of a level is promoted unchanged to the next level rather
 * than duplicated. Duplicating the last node is the Bitcoin construction and it
 * admits a known collision: a tree with an odd final node and one with that node
 * duplicated produce the same root, so two different descriptor lists can share a
 * root. Promotion has no such ambiguity.
 */

import { createHash } from 'node:crypto';

import { hashCanonicalForm, type ContentHash } from './canonical.js';
import { InternalError } from './errors.js';
import type { Descriptor, DescriptorCategory, SurfaceHashes } from './types.js';
import { DESCRIPTOR_CATEGORIES } from './types.js';

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

/**
 * Root of an empty tree.
 *
 * SHA-256 of the empty string. A server advertising no tools at all still needs a
 * well defined category root, and it must be distinguishable from the absence of
 * the category, which is why the surface omits absent categories entirely rather
 * than mapping them to this value.
 */
export const EMPTY_MERKLE_ROOT: ContentHash = hashCanonicalForm('');

function hexOf(hash: ContentHash): string {
  return hash.slice('sha256:'.length);
}

/** Hash a leaf value, with domain separation. */
export function merkleLeaf(value: ContentHash): ContentHash {
  const digest = createHash('sha256')
    .update(LEAF_PREFIX)
    .update(Buffer.from(hexOf(value), 'hex'))
    .digest('hex');
  return `sha256:${digest}`;
}

/** Hash two child nodes into their parent, with domain separation. */
export function merkleNode(left: ContentHash, right: ContentHash): ContentHash {
  const digest = createHash('sha256')
    .update(NODE_PREFIX)
    .update(Buffer.from(hexOf(left), 'hex'))
    .update(Buffer.from(hexOf(right), 'hex'))
    .digest('hex');
  return `sha256:${digest}`;
}

/**
 * Compute a merkle root over an ordered list of content hashes.
 *
 * Order is significant and is the caller's responsibility. Surface roots sort
 * descriptors by identity first, so that a server returning its tools in a
 * different order does not register as drift. The specification only *recommends*
 * deterministic ordering from `tools/list` (MS-TOOL-002, a SHOULD), so a
 * conforming server may legitimately reorder between calls and the trust layer
 * must not treat that as a change.
 */
export function merkleRoot(leaves: readonly ContentHash[]): ContentHash {
  if (leaves.length === 0) return EMPTY_MERKLE_ROOT;

  let level: ContentHash[] = leaves.map(merkleLeaf);

  while (level.length > 1) {
    const next: ContentHash[] = [];

    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1];

      /* c8 ignore next -- loop bounds guarantee left exists */
      if (left === undefined) throw new InternalError('merkle level index out of range');

      // Promote an odd trailing node rather than duplicating it. See the module
      // comment for why duplication is unsafe.
      next.push(right === undefined ? left : merkleNode(left, right));
    }

    level = next;
  }

  const root = level[0];
  /* c8 ignore next -- a non empty level always has a first element */
  if (root === undefined) throw new InternalError('merkle root missing');
  return root;
}

/** The key used for a descriptor in the per descriptor hash map. */
export function descriptorKey(category: DescriptorCategory, identity: string): string {
  return `${category}:${identity}`;
}

/**
 * Compute all three hash levels over a set of descriptors.
 *
 * Descriptors are sorted by identity within each category before hashing, so wire
 * order does not affect the result. Categories with no descriptors are omitted
 * from `byCategory` rather than mapped to the empty root, which keeps "advertises
 * no prompts" distinguishable from "advertises an empty prompt list".
 */
export function computeSurfaceHashes(descriptors: readonly Descriptor[]): SurfaceHashes {
  const byDescriptor: Record<string, ContentHash> = {};
  const byCategory: Partial<Record<DescriptorCategory, ContentHash>> = {};

  for (const descriptor of descriptors) {
    const key = descriptorKey(descriptor.category, descriptor.identity);

    if (key in byDescriptor) {
      // Two descriptors with the same identity in the same category means the
      // server advertised the same tool twice. Which one is authoritative is
      // undefined, so there is no honest hash for it.
      throw new InternalError(
        `Duplicate descriptor identity ${JSON.stringify(key)} in a single surface`,
        { details: { key } },
      );
    }

    byDescriptor[key] = descriptor.hash;
  }

  const categoryRoots: ContentHash[] = [];

  for (const category of DESCRIPTOR_CATEGORIES) {
    const inCategory = descriptors
      .filter((d) => d.category === category)
      .sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));

    if (inCategory.length === 0) continue;

    const root = merkleRoot(inCategory.map((d) => d.hash));
    byCategory[category] = root;

    // The category name is folded in so that the same descriptor list under two
    // different categories cannot produce the same surface root.
    categoryRoots.push(merkleNode(hashCanonicalForm(category), root));
  }

  return {
    root: merkleRoot(categoryRoots),
    byCategory,
    byDescriptor,
  };
}

/**
 * An inclusion proof: the sibling hashes needed to recompute a root from a leaf.
 *
 * `index` is the leaf's position in the ordered list the root was built from.
 */
export interface MerkleProof {
  readonly index: number;
  readonly leafCount: number;
  readonly siblings: readonly MerkleProofStep[];
}

export interface MerkleProofStep {
  readonly hash: ContentHash;
  readonly side: 'left' | 'right';
}

/**
 * Build an inclusion proof for one leaf.
 *
 * Lets a holder of a ledger entry prove a specific tool definition was present in
 * a specific capture without republishing the entire surface, which matters when
 * the surface itself is the sensitive part.
 */
export function buildMerkleProof(
  leaves: readonly ContentHash[],
  index: number,
): MerkleProof {
  if (index < 0 || index >= leaves.length) {
    throw new InternalError(
      `Leaf index ${String(index)} out of range for ${String(leaves.length)} leaves`,
      { details: { index, leafCount: leaves.length } },
    );
  }

  const siblings: MerkleProofStep[] = [];
  let level: ContentHash[] = leaves.map(merkleLeaf);
  let position = index;

  while (level.length > 1) {
    const isRightChild = position % 2 === 1;
    const siblingIndex = isRightChild ? position - 1 : position + 1;
    const sibling = level[siblingIndex];

    // No sibling means this node was promoted rather than paired, so nothing is
    // added to the proof for this level.
    if (sibling !== undefined) {
      siblings.push({ hash: sibling, side: isRightChild ? 'left' : 'right' });
    }

    const next: ContentHash[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1];
      /* c8 ignore next */
      if (left === undefined) throw new InternalError('merkle level index out of range');
      next.push(right === undefined ? left : merkleNode(left, right));
    }

    level = next;
    position = Math.floor(position / 2);
  }

  return { index, leafCount: leaves.length, siblings };
}

/** Recompute a root from a leaf and its proof, for verification. */
export function verifyMerkleProof(
  leaf: ContentHash,
  proof: MerkleProof,
  expectedRoot: ContentHash,
): boolean {
  let current = merkleLeaf(leaf);

  for (const step of proof.siblings) {
    current =
      step.side === 'left' ? merkleNode(step.hash, current) : merkleNode(current, step.hash);
  }

  return current === expectedRoot;
}
