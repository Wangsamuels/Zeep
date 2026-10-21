// Append-only binary Poseidon Merkle tree, matching circuits-src/zeep_spend.circom:
// empty leaves are 0 and each parent is Poseidon(left, right).
import { poseidon2 } from 'poseidon-lite';

const zeroCache = new Map<number, bigint[]>();
export function zeros(depth: number): bigint[] {
  let z = zeroCache.get(depth);
  if (!z) {
    z = [0n];
    for (let i = 0; i < depth; i++) z.push(poseidon2([z[i], z[i]]));
    zeroCache.set(depth, z);
  }
  return z;
}

export class MerkleTree {
  private layers: bigint[][];
  private z: bigint[];

  constructor(public readonly depth: number) {
    this.z = zeros(depth);
    this.layers = Array.from({ length: depth + 1 }, () => []);
  }

  get size(): number {
    return this.layers[0].length;
  }

  get capacity(): number {
    return 2 ** this.depth;
  }

  root(): bigint {
    return this.layers[this.depth][0] ?? this.z[this.depth];
  }

  leaf(i: number): bigint | undefined {
    return this.layers[0][i];
  }

  /** Bulk load (boot). Builds each layer once instead of hashing every path. */
  load(leaves: bigint[]): void {
    if (leaves.length > this.capacity) throw new Error('tree full');
    this.layers[0] = leaves.slice();
    for (let d = 0; d < this.depth; d++) {
      const cur = this.layers[d];
      const next: bigint[] = new Array(Math.ceil(cur.length / 2));
      for (let i = 0; i < next.length; i++) {
        next[i] = poseidon2([cur[2 * i], cur[2 * i + 1] ?? this.z[d]]);
      }
      this.layers[d + 1] = next;
    }
  }

  /** Set leaf `index` (append when index === size) and update its path. */
  set(index: number, leaf: bigint): bigint {
    if (index > this.size) throw new Error(`leaf ${index} would leave a gap (size ${this.size})`);
    if (index >= this.capacity) throw new Error('tree full');
    this.layers[0][index] = leaf;
    let i = index;
    for (let d = 0; d < this.depth; d++) {
      const left = this.layers[d][i & ~1];
      const right = this.layers[d][i | 1] ?? this.z[d];
      i >>= 1;
      this.layers[d + 1][i] = poseidon2([left ?? this.z[d], right]);
    }
    return this.root();
  }

  append(leaf: bigint): { index: number; root: bigint } {
    const index = this.size;
    return { index, root: this.set(index, leaf) };
  }

  /** Sibling path for a leaf (used by tests and tooling; clients build their own). */
  path(index: number): { pathElements: bigint[]; pathIndices: number[] } {
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
    let i = index;
    for (let d = 0; d < this.depth; d++) {
      pathElements.push(this.layers[d][i ^ 1] ?? this.z[d]);
      pathIndices.push(i & 1);
      i >>= 1;
    }
    return { pathElements, pathIndices };
  }
}
