// Isolating: does LiteSVM crash after a fixed small number of TOTAL sendTransaction calls,
// regardless of instruction type? Pure system-program transfers only, no Anchor, no program.
const { LiteSVM, FeatureSet } = require("litesvm");
const { Keypair, SystemProgram, Transaction } = require("@solana/web3.js");

async function main() {
    const svm = new LiteSVM().withFeatureSet(FeatureSet.allEnabled()).withPrecompiles();
    const payer = Keypair.generate();
    svm.airdrop(payer.publicKey, BigInt(100_000_000_000));
    console.log("OK  setup: LiteSVM + one-time airdrop to payer");

    for (let i = 1; i <= 15; i++) {
        const dest = Keypair.generate();
        const tx = new Transaction().add(SystemProgram.transfer({
            fromPubkey: payer.publicKey, toPubkey: dest.publicKey, lamports: 1000,
        }));
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = payer.publicKey;
        tx.sign(payer);
        const result = svm.sendTransaction(tx);
        if ("Err" in result) {
            console.log(`iteration ${i}: FAILED (Err): ${JSON.stringify(result.Err)}`);
            continue;
        }
        console.log(`iteration ${i}: OK sendTransaction succeeded`);
        const clock = svm.getClock();
        svm.warpToSlot(clock.slot + BigInt(1));
        svm.expireBlockhash();
    }
    console.log("\nALL 15 iterations completed without crashing.");
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
