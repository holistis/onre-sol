// Al-Mizaan gate 7 PoC — NOT part of OnRe's own test suite, written for independent security
// research to prove or kill the hypothesis: the redemption flow (create/cancel_redemption_request)
// never calls has_transfer_fee() (unlike take_offer, which explicitly rejects Token-2022
// fee-bearing mints with "Token-2022 with transfer fees not supported"). If a redemption offer's
// token_in_mint is a Token-2022 mint with a transfer fee, the vault is credited NET (post-fee) on
// deposit but debited GROSS (recorded, pre-fee) on cancel — an ordinary second redeemer can be
// stuck with no way to exit, no malice or timing attack required.
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
    TOKEN_2022_PROGRAM_ID,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction,
    createMintToInstruction,
} from "@solana/spl-token";
import { TestHelper } from "../test_helper";
import { OnreProgram } from "../onre_program.ts";

describe("PoC: Token-2022 transfer-fee guard missing in redemption flow", () => {
    let testHelper: TestHelper;
    let program: OnreProgram;

    const GROSS_AMOUNT = 1_000_000_000; // 1 token @ 9 decimals, matches take_offer.spec.ts's own rejection-test fixture
    const FEE_BPS = 500; // 5%
    const MAX_FEE = BigInt(5_000_000); // same cap used in take_offer.spec.ts -> effective fee = min(5% of amount, maxFee) = 5_000_000

    it("second honest redeemer cannot cancel/exit after an earlier redeemer's ordinary cancel — vault insolvency, no malice required", async () => {
        testHelper = await TestHelper.create();
        program = new OnreProgram(testHelper);

        // token_out for the redemption (paid out to redeemers) — plain SPL, mirrors USDC role.
        const usdcMint = testHelper.createMint(6);
        // ONyc-like placeholder mint required by initialize(); unrelated to the vulnerable mint.
        const onycMint = testHelper.createMint(9);
        await program.initialize({ onycMint });

        const redemptionAdmin = testHelper.createUserAccount();
        await program.setRedemptionAdmin({ redemptionAdmin: redemptionAdmin.publicKey });

        // The vulnerable mint: Token-2022 with a non-zero transfer fee, used as redemption token_in.
        const feeMint = await testHelper.createMint2022WithTransferFee(9, FEE_BPS, MAX_FEE);

        // A standard Offer (feeMint -> usdcMint) must exist first; makeRedemptionOffer derives its
        // own token_in/token_out from this Offer's mints in reverse (see onre_program.ts:456-457).
        await program.makeOffer({
            tokenInMint: usdcMint,
            tokenOutMint: feeMint,
        });
        const offerPda = program.getOfferPda(usdcMint, feeMint);

        await program.makeRedemptionOffer({ offer: offerPda, tokenInProgram: TOKEN_2022_PROGRAM_ID });
        const redemptionOfferPda = program.getRedemptionOfferPda(feeMint, usdcMint);

        // Two ordinary, unrelated redeemers, each funded with the fee-bearing mint.
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

        // Create the redemption vault's Token-2022 ATA (PDA-owned) before any deposit.
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

        // --- Step 1: this call is where take_offer would have thrown
        // "Token-2022 with transfer fees not supported". The redemption path has no such guard —
        // proving the asymmetry directly, not just by grep.
        await program.createRedemptionRequest({
            redemptionOffer: redemptionOfferPda, redeemer: redeemerA, amount: GROSS_AMOUNT, tokenProgram: TOKEN_2022_PROGRAM_ID,
        });
        await program.createRedemptionRequest({
            redemptionOffer: redemptionOfferPda, redeemer: redeemerB, amount: GROSS_AMOUNT, tokenProgram: TOKEN_2022_PROGRAM_ID,
        });

        const vaultAfterDeposits = await testHelper.getTokenAccountBalance(vaultAta);
        // Each deposit credited the vault only GROSS - fee, while the program recorded GROSS.
        const expectedNetPerDeposit = BigInt(GROSS_AMOUNT) - MAX_FEE;
        expect(vaultAfterDeposits).toBe(expectedNetPerDeposit * BigInt(2));

        const redemptionOfferAfterDeposits = await program.getRedemptionOffer(feeMint, usdcMint);
        expect(redemptionOfferAfterDeposits.requestedRedemptions.toString()).toBe((GROSS_AMOUNT * 2).toString());
        // The gap between what's recorded as owed and what the vault actually holds:
        const recordedObligation = BigInt(GROSS_AMOUNT) * BigInt(2);
        expect(recordedObligation).toBeGreaterThan(vaultAfterDeposits); // solvency invariant already broken here

        // --- Step 2: redeemer A cancels first (ordinary, honest action) — succeeds because the
        // vault still holds enough from B's deposit to cover A's gross-recorded amount.
        const redemptionRequestAPda = program.getRedemptionRequestPda(redemptionOfferPda, 0);
        await program.cancelRedemptionRequest({
            redemptionOffer: redemptionOfferPda,
            redemptionRequest: redemptionRequestAPda,
            signer: redeemerA,
            redemptionAdmin: redemptionAdmin.publicKey,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
        });

        const vaultAfterACancel = await testHelper.getTokenAccountBalance(vaultAta);
        // A's cancel debited the full recorded GROSS_AMOUNT from the vault (not the net it actually contributed).
        expect(vaultAfterACancel).toBe(vaultAfterDeposits - BigInt(GROSS_AMOUNT));

        // --- Step 3: B, an entirely honest, unrelated redeemer who did nothing wrong, tries to
        // cancel their own still-pending request and now cannot — the vault no longer holds enough
        // to cover B's own recorded gross amount, because A's cancel (a normal, allowed action)
        // consumed part of what was actually B's principal.
        const redemptionRequestBPda = program.getRedemptionRequestPda(redemptionOfferPda, 1);

        await expect(
            program.cancelRedemptionRequest({
                redemptionOffer: redemptionOfferPda,
                redemptionRequest: redemptionRequestBPda,
                signer: redeemerB,
                redemptionAdmin: redemptionAdmin.publicKey,
                tokenProgram: TOKEN_2022_PROGRAM_ID,
            })
        ).rejects.toThrow();

        console.log(
            `PoC confirmed: vault held ${vaultAfterACancel} but B's own recorded redemption amount is ${GROSS_AMOUNT} — B is stuck.`
        );
    });
});
