// Build a 2-in/2-out spend in one asset: choose inputs, compute paths, make outputs, prove.
// Public signals order (must match the server):
//   [root0, root1, nullifier0, nullifier1, outCommitment0, outCommitment1, cost, asset, signal,
//    tag, tagEpoch, tagPurpose]
import { randomField } from "./field";
import type { ZeepKeys } from "./keys";
import { dummyEnc, encryptNote, newOutput, noteCommitment, nullifierOf, ownerTag, type Asset, type Note } from "./notes";
import { zeros } from "./tree";
import { poseidon3 } from "poseidon-lite";

export const DEPTH = 20;

/** Daily tag purposes: the first tag of each per UTC day is fee-free. */
export const TAG = { none: 0, withdrawal: 1, depositRebate: 2 } as const;
export const utcDay = (t = Date.now()): number => Math.floor(t / 86_400_000);

export interface Paths {
  /** Merkle path for a leaf; the tree must already be synced. */
  path(tree: number, index: number): { pathElements: bigint[]; pathIndices: number[]; root: bigint };
  /** Any currently accepted root (used for dummy inputs). */
  anyRoot(): bigint;
}

/** Runs Groth16 proving: snarkjs.groth16.fullProve in Node, a Web Worker in the browser. */
export type ProveFn = (input: Record<string, unknown>) => Promise<{ proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }; publicSignals: string[] }>;

export interface SpendPlan {
  /** 0 dollars, 1 ZEC: inputs, outputs and cost are all in this asset. */
  asset: Asset;
  inputs: Note[]; // 0, 1 or 2 real notes of `asset`
  cost: bigint;
  signal: bigint;
  /** Optional second output to someone else (agent funding). */
  transfer?: { pk: bigint; amount: bigint; noteKey?: Uint8Array };
  /** Reveal today's tag for this purpose (withdrawal / deposit rebate). Default: random tag. */
  daily?: 1 | 2;
  /** Secret of the refund note; its owner tag must already be bound into `signal` (pay()). */
  refundRho?: bigint;
}

export interface BuiltSpend {
  bundle: {
    root: [string, string];
    nullifier: [string, string];
    out: [{ c: string; e: string }, { c: string; e: string }];
    cost: string;
    asset: Asset;
    tag: { value: string; epoch: string; purpose: number };
    proof: string[];
    compensate?: { d: string; e: string };
  };
  /** The change note (output 0) to add once the server confirms its position. */
  change: { rho: bigint; amount: bigint; commitment: bigint };
  /** Output 1 (an agent's note, or a zero-value dummy). */
  second: { rho: bigint; amount: bigint; commitment: bigint };
  /** Where a failed request's money comes back, if the server compensates. */
  refund: { rho: bigint; amount: bigint };
}

export async function buildSpend(keys: ZeepKeys, plan: SpendPlan, paths: Paths, prove: ProveFn): Promise<BuiltSpend> {
  if (plan.inputs.length > 2) throw new Error("a spend uses at most two notes");
  if (plan.inputs.length === 0 && plan.cost > 0n) throw new Error("a paid spend needs at least one note");
  if (plan.inputs.some((n) => n.asset !== plan.asset)) throw new Error("all inputs must be of the spend's asset");
  const total = plan.inputs.reduce((s, n) => s + BigInt(n.amount), 0n);
  const transfer = plan.transfer?.amount ?? 0n;
  const changeAmount = total - plan.cost - transfer;
  if (changeAmount < 0n) throw new Error("not enough in these notes");

  const ins = plan.inputs.map((n) => {
    const p = paths.path(n.tree, n.index);
    return { rho: BigInt(n.rho), amount: BigInt(n.amount), ...p };
  });
  while (ins.length < 2) {
    // Zero-value dummy: membership is not enforced by the circuit for amount 0.
    const z = zeros(DEPTH);
    ins.push({ rho: randomField(), amount: 0n, pathElements: z.slice(0, DEPTH), pathIndices: Array(DEPTH).fill(0), root: paths.anyRoot() });
  }
  const tagPurpose = BigInt(plan.daily ?? TAG.none);
  const tagEpoch = plan.daily ? BigInt(utcDay()) : randomField(); // random epoch → random, unlinkable tag
  const tag = poseidon3([keys.sk, tagEpoch, tagPurpose]);

  const change = newOutput(keys.pk, changeAmount, plan.asset);
  const second = plan.transfer ? newOutput(plan.transfer.pk, plan.transfer.amount, plan.asset) : newOutput(keys.pk, 0n, plan.asset);
  const outs = [change, second];

  const input = {
    root: ins.map((i) => i.root.toString()),
    nullifier: ins.map((i) => nullifierOf(keys.sk, i.rho).toString()),
    outCommitment: outs.map((o) => o.commitment.toString()),
    cost: plan.cost.toString(),
    asset: String(plan.asset),
    signalHash: plan.signal.toString(),
    tag: tag.toString(),
    tagEpoch: tagEpoch.toString(),
    tagPurpose: tagPurpose.toString(),
    sk: keys.sk.toString(),
    inAmount: ins.map((i) => i.amount.toString()),
    inRho: ins.map((i) => i.rho.toString()),
    pathElements: ins.map((i) => i.pathElements.map(String)),
    pathIndices: ins.map((i) => i.pathIndices.map(String)),
    outAmount: outs.map((o) => o.amount.toString()),
    outD: outs.map((o) => o.d.toString()),
  };
  const { proof, publicSignals } = await prove(input);
  const expect = [...input.root, ...input.nullifier, ...input.outCommitment, input.cost, input.asset, input.signalHash, input.tag, input.tagEpoch, input.tagPurpose];
  if (publicSignals.join() !== expect.join()) throw new Error("prover returned unexpected public signals");

  const refundRho = plan.refundRho ?? randomField();
  return {
    bundle: {
      root: [input.root[0], input.root[1]],
      nullifier: [input.nullifier[0], input.nullifier[1]],
      out: [
        { c: input.outCommitment[0], e: await encryptNote(keys.noteKey, changeAmount, change.rho, plan.asset) },
        { c: input.outCommitment[1], e: plan.transfer?.noteKey ? await encryptNote(plan.transfer.noteKey, plan.transfer.amount, second.rho, plan.asset) : dummyEnc() },
      ],
      cost: input.cost,
      asset: plan.asset,
      tag: { value: input.tag, epoch: input.tagEpoch, purpose: Number(tagPurpose) },
      proof: [proof.pi_a[0], proof.pi_a[1], proof.pi_b[0][0], proof.pi_b[0][1], proof.pi_b[1][0], proof.pi_b[1][1], proof.pi_c[0], proof.pi_c[1]],
      compensate: plan.cost > 0n
        ? { d: ownerTag(keys.pk, refundRho).toString(), e: await encryptNote(keys.noteKey, plan.cost, refundRho, plan.asset) }
        : undefined,
    },
    change: { rho: change.rho, amount: changeAmount, commitment: change.commitment },
    second: { rho: second.rho, amount: second.amount, commitment: second.commitment },
    refund: { rho: refundRho, amount: plan.cost },
  };
}

export { noteCommitment };
