pragma circom 2.1.6;

// Zeep private balance: a 2-in / 2-out shielded note spend (same idea as Zcash's notes).
//
//   pk          = Poseidon(sk)                       the user's Zeep key, derived from their seed
//   d           = Poseidon(pk, rho)                  per-note owner tag (rho is random per note)
//   commitment  = Poseidon(d, amount, asset)         the Merkle leaf
//   nullifier   = Poseidon(sk, rho)                  revealed when the note is spent
//
// Two assets: 0 = dollars (amount in micro-USD), 1 = ZEC (amount in zatoshis). A spend works
// in exactly one asset (public): all inputs, outputs and the cost are that asset, so value is
// conserved per asset. Converting between them is done by the server (burn one, mint the other).
//
// One proof spends up to two notes, charges a public `cost` (zats), and creates two new
// notes holding the remainder. The server learns only the cost, never a balance, and can't
// link the new notes to the old ones. The same circuit covers:
//   paying for a request   cost = route price, outputs = change
//   withdrawing            cost = amount to pay out (signalHash binds the payout address)
//   merging / splitting    cost = 0
//   funding an agent       cost = 0, one output owned by the agent's key (outD)
//
// A zero-amount input is a dummy: its Merkle membership is not enforced.

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

template MerkleRoot(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    component h[depth];
    signal cur[depth + 1];
    signal left[depth];
    signal right[depth];
    cur[0] <== leaf;
    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;
        left[i] <== cur[i] + pathIndices[i] * (pathElements[i] - cur[i]);
        right[i] <== pathElements[i] + pathIndices[i] * (cur[i] - pathElements[i]);
        h[i] = Poseidon(2);
        h[i].inputs[0] <== left[i];
        h[i].inputs[1] <== right[i];
        cur[i + 1] <== h[i].out;
    }
    root <== cur[depth];
}

template Spend(depth, amountBits) {
    // ---- public ----
    signal input root[2];
    signal input nullifier[2];
    signal input outCommitment[2];
    signal input cost;
    signal input asset;
    signal input signalHash;
    signal input tag;
    signal input tagEpoch;
    signal input tagPurpose;

    // ---- private ----
    signal input sk;
    signal input inAmount[2];
    signal input inRho[2];
    signal input pathElements[2][depth];
    signal input pathIndices[2][depth];
    signal input outAmount[2];
    signal input outD[2];

    asset * (asset - 1) === 0; // 0 dollars, 1 ZEC

    component pk = Poseidon(1);
    pk.inputs[0] <== sk;

    component dIn[2];
    component leaf[2];
    component mr[2];
    component nf[2];
    component inRange[2];
    component outRange[2];
    component outCm[2];

    for (var i = 0; i < 2; i++) {
        inRange[i] = Num2Bits(amountBits);
        inRange[i].in <== inAmount[i];

        dIn[i] = Poseidon(2);
        dIn[i].inputs[0] <== pk.out;
        dIn[i].inputs[1] <== inRho[i];

        leaf[i] = Poseidon(3);
        leaf[i].inputs[0] <== dIn[i].out;
        leaf[i].inputs[1] <== inAmount[i];
        leaf[i].inputs[2] <== asset;

        mr[i] = MerkleRoot(depth);
        mr[i].leaf <== leaf[i].out;
        for (var j = 0; j < depth; j++) {
            mr[i].pathElements[j] <== pathElements[i][j];
            mr[i].pathIndices[j] <== pathIndices[i][j];
        }
        // Membership is enforced unless the input is a zero-value dummy.
        (mr[i].root - root[i]) * inAmount[i] === 0;

        nf[i] = Poseidon(2);
        nf[i].inputs[0] <== sk;
        nf[i].inputs[1] <== inRho[i];
        nullifier[i] === nf[i].out;

        outRange[i] = Num2Bits(amountBits);
        outRange[i].in <== outAmount[i];

        outCm[i] = Poseidon(3);
        outCm[i].inputs[0] <== outD[i];
        outCm[i].inputs[1] <== outAmount[i];
        outCm[i].inputs[2] <== asset;
        outCommitment[i] === outCm[i].out;
    }

    component costRange = Num2Bits(amountBits);
    costRange.in <== cost;

    // Value is conserved: nothing is created, the cost is the only thing that leaves.
    inAmount[0] + inAmount[1] === outAmount[0] + outAmount[1] + cost;

    component dailyTag = Poseidon(3);
    dailyTag.inputs[0] <== sk;
    dailyTag.inputs[1] <== tagEpoch;
    dailyTag.inputs[2] <== tagPurpose;
    tag === dailyTag.out;

    // Bind the proof to one request (route + body, or refund id + payout address).
    signal signalSquared;
    signalSquared <== signalHash * signalHash;
}

// 2^52 > the 21M ZEC supply in zats and > $4.5B in micro-USD; depth 20 = ~1M notes per tree (trees rotate when full).
component main {public [root, nullifier, outCommitment, cost, asset, signalHash, tag, tagEpoch, tagPurpose]} = Spend(20, 52);
