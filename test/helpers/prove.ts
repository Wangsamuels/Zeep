// Node prover for the SDK (the browser uses a Web Worker with the same snarkjs call).
import * as snarkjs from 'snarkjs';
import type { ProveFn } from '../../sdk/spend';

export const CIRCUIT = {
  wasm: new URL('../../circuits/zeep_spend.wasm', import.meta.url).pathname,
  zkey: new URL('../../circuits/zeep_spend.zkey', import.meta.url).pathname,
  vkey: new URL('../../circuits/zeep_spend_vkey.json', import.meta.url).pathname,
};

export const nodeProve: ProveFn = (input) => snarkjs.groth16.fullProve(input, CIRCUIT.wasm, CIRCUIT.zkey) as ReturnType<ProveFn>;
