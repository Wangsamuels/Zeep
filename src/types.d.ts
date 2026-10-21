declare module 'snarkjs' {
  export const groth16: {
    verify(vk: object, publicSignals: string[], proof: object, logger?: unknown): Promise<boolean>;
    fullProve(input: Record<string, unknown>, wasm: string, zkey: string): Promise<{ proof: any; publicSignals: string[] }>;
  };
}
