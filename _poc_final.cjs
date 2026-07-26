// Self-contained PoC — plain CJS, no tsx/vitest module-loading path (proven crash source
// eliminated). Uses the REAL @coral-xyz/anchor Program class directly against the actual
// compiled onreapp.so via LiteSVM. Same vulnerability scenario as
// tests/redemption/_poc_token2022_fee_insolvency.spec.ts, ported to avoid the crashing loader.
const { LiteSVM, FeatureSet } = require("litesvm");
const {
    getAssociatedTokenAddressSync, ExtensionType, getMintLen,
    createInitializeMint2Instruction, createInitializeTransferFeeConfigInstruction,
    createAssociatedTokenAccountInstruction, createMintToInstruction,
    AccountLayout, MintLayout, ACCOUNT_SIZE, MINT_SIZE,
    TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} = require("@solana/spl-token");
const { Keypair, PublicKey, SystemProgram, Transaction } = require("@solana/web3.js");
const { AnchorProvider, BN, Program, Wallet } = require("@coral-xyz/anchor");
const fs = require("fs");
const path = require("path");
const idl = require("./target/idl/onreapp.json");

const INITIAL_LAMPORTS = 1_000_000_000;
const BPF_UPGRADEABLE_LOADER_PROGRAM_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const ONREAPP_PROGRAM_ID = new PublicKey(idl.address);

function assertEqual(actual, expected, label) {
    const a = String(actual);
    const e = String(expected);
    if (a !== e) throw new Error(`ASSERTION FAILED: ${label} — expected ${e}, got ${a}`);
    console.log(`  OK  ${label} (${a})`);
}

async function main() {
    // ---- Set up LiteSVM + deploy the real compiled program (ported from TestHelper.create()) ----
    const svm = new LiteSVM().withFeatureSet(FeatureSet.allEnabled()).withPrecompiles();
    const payer = Keypair.generate();
    const clock = svm.getClock();
    clock.unixTimestamp = BigInt(1704067200);
    svm.setClock(clock);
    svm.airdrop(payer.publicKey, BigInt(100_000_000_000));

    const programBytes = fs.readFileSync(path.join(process.cwd(), "target/deploy/onreapp.so"));
    const programDataPda = PublicKey.findProgramAddressSync(
        [ONREAPP_PROGRAM_ID.toBuffer()], BPF_UPGRADEABLE_LOADER_PROGRAM_ID
    )[0];
    const programDataAccountData = Buffer.alloc(45 + programBytes.length);
    programDataAccountData.writeUInt32LE(3, 0);
    programDataAccountData.writeBigUInt64LE(BigInt(0), 4);
    programDataAccountData.writeUInt8(1, 12);
    payer.publicKey.toBuffer().copy(programDataAccountData, 13);
    programBytes.copy(programDataAccountData, 45);
    svm.setAccount(programDataPda, { executable: false, data: programDataAccountData, lamports: 10_000_000, owner: BPF_UPGRADEABLE_LOADER_PROGRAM_ID });
    const programAccountData = Buffer.alloc(36);
    programAccountData.writeUInt32LE(2, 0);
    programDataPda.toBuffer().copy(programAccountData, 4);
    svm.setAccount(ONREAPP_PROGRAM_ID, { executable: true, data: programAccountData, lamports: 1_000_000, owner: BPF_UPGRADEABLE_LOADER_PROGRAM_ID });
    console.log("OK  program deployed into LiteSVM from the real compiled .so");

    function advanceSlot() {
        const clock = svm.getClock();
        svm.warpToSlot(clock.slot + BigInt(1));
        svm.expireBlockhash();
    }

    let lastBlockhash = svm.latestBlockhash();
    async function sendAndConfirm(tx, signers) {
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = payer.publicKey;
        tx.sign(...signers);
        const result = svm.sendTransaction(tx);
        if ("Err" in result) throw new Error(`Transaction failed: ${JSON.stringify(result.Err)}`);
        advanceSlot();
        return result;
    }

    function createMint(decimals) {
        const mintData = Buffer.alloc(MINT_SIZE);
        MintLayout.encode({
            mintAuthorityOption: 1, mintAuthority: payer.publicKey,
            supply: BigInt(999_999_999 * 10 ** decimals), decimals, isInitialized: true,
            freezeAuthorityOption: 1, freezeAuthority: payer.publicKey,
        }, mintData);
        const mintAddress = PublicKey.unique();
        svm.setAccount(mintAddress, { executable: false, data: mintData, lamports: INITIAL_LAMPORTS, owner: TOKEN_PROGRAM_ID });
        return mintAddress;
    }

    async function createMint2022WithTransferFee(decimals, feeBps, maxFee) {
        const mint = Keypair.generate();
        const extensions = [ExtensionType.TransferFeeConfig];
        const mintLen = getMintLen(extensions);
        const createAccountIx = SystemProgram.createAccount({
            fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: mintLen,
            lamports: INITIAL_LAMPORTS, programId: TOKEN_2022_PROGRAM_ID,
        });
        const initFeeIx = createInitializeTransferFeeConfigInstruction(mint.publicKey, payer.publicKey, payer.publicKey, feeBps, maxFee, TOKEN_2022_PROGRAM_ID);
        const initMintIx = createInitializeMint2Instruction(mint.publicKey, decimals, payer.publicKey, payer.publicKey, TOKEN_2022_PROGRAM_ID);
        const tx = new Transaction().add(createAccountIx, initFeeIx, initMintIx);
        await sendAndConfirm(tx, [payer, mint]);
        return mint.publicKey;
    }

    async function createUserAccount() {
        const user = Keypair.generate();
        // NOTE: svm.airdrop() called a second time crashes LiteSVM natively (isolated via
        // diagnostics — the payer's one-time setup airdrop is fine, a second airdrop() call
        // is not). Fund new users via a plain SystemProgram.transfer from the already-funded
        // payer instead — economically identical for this PoC's purposes.
        await sendAndConfirm(new Transaction().add(SystemProgram.transfer({
            fromPubkey: payer.publicKey, toPubkey: user.publicKey, lamports: INITIAL_LAMPORTS,
        })), [payer]);
        return user;
    }

    async function getTokenAccountBalance(addr) {
        const acct = svm.getAccount(addr);
        if (!acct) throw new Error("account not found: " + addr.toBase58());
        return AccountLayout.decode(acct.data).amount;
    }

    // ---- AnchorProvider + real Program, direct (proven to work in plain CJS) ----
    const wallet = new Wallet(payer);
    const connection = {
        getLatestBlockhash: async () => ({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: 0 }),
        getMinimumBalanceForRentExemption: async () => 890880,
        getAccountInfo: async (pk) => { const a = svm.getAccount(pk); return a ? { ...a, data: Buffer.from(a.data) } : null; },
        getAccountInfoAndContext: async (pk) => { const a = svm.getAccount(pk); return { context: { slot: 0 }, value: a ? { ...a, data: Buffer.from(a.data) } : null }; },
        sendRawTransaction: async (raw) => {
            const tx = Transaction.from(raw);
            const result = svm.sendTransaction(tx);
            if (typeof result.err === "function") {
                const logs = result.meta().logs();
                const error = new Error(result.toString());
                error.logs = logs;
                throw error;
            }
            advanceSlot();
            return "signature";
        },
        confirmTransaction: async () => ({ value: { err: null } }),
        _rpcRequest: async (method, args) => {
            if (method === "simulateTransaction") {
                const tx = Transaction.from(Buffer.from(args[0], "base64"));
                if (!tx.signatures.some((s) => s.signature !== null)) {
                    tx.recentBlockhash = svm.latestBlockhash();
                    tx.feePayer = payer.publicKey;
                    tx.partialSign(payer);
                }
                const result = svm.simulateTransaction(tx);
                if ("Err" in result) {
                    const err = result.Err;
                    const meta = err.meta();
                    return { context: { slot: 0 }, value: { err: err.err(), logs: meta.logs(), accounts: null, unitsConsumed: Number(meta.computeUnitsConsumed()), returnData: null } };
                }
                const meta = result.meta();
                return { context: { slot: 0 }, value: { err: null, logs: meta.logs(), accounts: null, unitsConsumed: Number(meta.computeUnitsConsumed()), returnData: null } };
            }
            throw new Error("Unsupported RPC method: " + method);
        },
    };
    const provider = new AnchorProvider(connection, wallet, { commitment: "processed" });
    const program = new Program(idl, provider);
    console.log("OK  real anchor.Program instantiated against the deployed program");

    const pdas = {
        statePda: PublicKey.findProgramAddressSync([Buffer.from("state")], ONREAPP_PROGRAM_ID)[0],
        redemptionVaultAuthorityPda: PublicKey.findProgramAddressSync([Buffer.from("redemption_offer_vault_authority")], ONREAPP_PROGRAM_ID)[0],
    };

    function getOfferPda(tokenInMint, tokenOutMint) {
        return PublicKey.findProgramAddressSync([Buffer.from("offer"), tokenInMint.toBuffer(), tokenOutMint.toBuffer()], ONREAPP_PROGRAM_ID)[0];
    }
    function getRedemptionOfferPda(tokenInMint, tokenOutMint) {
        return PublicKey.findProgramAddressSync([Buffer.from("redemption_offer"), tokenInMint.toBuffer(), tokenOutMint.toBuffer()], ONREAPP_PROGRAM_ID)[0];
    }
    function getRedemptionRequestPda(redemptionOffer, counter) {
        return PublicKey.findProgramAddressSync([Buffer.from("redemption_request"), redemptionOffer.toBuffer(), new BN(counter).toArrayLike(Buffer, "le", 8)], ONREAPP_PROGRAM_ID)[0];
    }

    // ================= THE ACTUAL VULNERABILITY SCENARIO =================
    const GROSS_AMOUNT = 1_000_000_000;
    const FEE_BPS = 500;
    const MAX_FEE = BigInt(5_000_000);

    const usdcMint = createMint(6);
    const onycMint = createMint(9);

    await program.methods.initialize().accounts({
        boss: payer.publicKey, onycMint,
        programData: PublicKey.findProgramAddressSync([program.programId.toBuffer()], BPF_UPGRADEABLE_LOADER_PROGRAM_ID)[0],
    }).rpc({ skipPreflight: true });
    console.log("OK  initialize()");

    console.log("diag: raw svm.getAccount(statePda) right after initialize()...");
    const rawStateAcct = svm.getAccount(pdas.statePda);
    console.log("diag: OK, raw account bytes length =", rawStateAcct ? rawStateAcct.data.length : "null");

    console.log("diag: program.account.state.fetch() via Anchor's decoder...");
    const stateViaAnchor = await program.account.state.fetch(pdas.statePda);
    console.log("diag: OK, boss on state =", stateViaAnchor.boss.toBase58());

    console.log("diag: second harmless transaction — plain SOL transfer, no program involved...");
    const throwaway = Keypair.generate();
    await sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: throwaway.publicKey, lamports: 1000 })), [payer]);
    console.log("diag: OK, plain second transaction survived");

    const redemptionAdmin = await createUserAccount();
    console.log("about to call setRedemptionAdmin with EXPLICIT accounts (state PDA + boss)...");
    await program.methods.setRedemptionAdmin(redemptionAdmin.publicKey).accounts({
        state: pdas.statePda, boss: payer.publicKey,
    }).rpc({ skipPreflight: true });
    console.log("OK  setRedemptionAdmin()");

    const feeMint = await createMint2022WithTransferFee(9, FEE_BPS, MAX_FEE);
    console.log("OK  Token-2022 fee mint created:", feeMint.toBase58());

    await program.methods.makeOffer(0, false, false).accounts({
        tokenInMint: usdcMint, tokenInProgram: TOKEN_PROGRAM_ID, tokenOutMint: feeMint,
    }).rpc({ skipPreflight: true });
    const offerPda = getOfferPda(usdcMint, feeMint);
    console.log("OK  makeOffer() — base offer usdc->feeMint created");

    await program.methods.makeRedemptionOffer(0).accounts({
        offer: offerPda, tokenInMint: feeMint, tokenOutMint: usdcMint,
        tokenInProgram: TOKEN_2022_PROGRAM_ID, tokenOutProgram: TOKEN_PROGRAM_ID,
        signer: payer.publicKey,
    }).rpc({ skipPreflight: true });
    const redemptionOfferPda = getRedemptionOfferPda(feeMint, usdcMint);
    console.log("OK  makeRedemptionOffer() — redemption feeMint->usdc created (THIS IS WHERE take_offer WOULD HAVE THROWN 'Token-2022 with transfer fees not supported' — no such rejection happened)");

    async function fundRedeemer() {
        const user = await createUserAccount();
        const ata = getAssociatedTokenAddressSync(feeMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
        const createAtaIx = createAssociatedTokenAccountInstruction(payer.publicKey, ata, user.publicKey, feeMint, TOKEN_2022_PROGRAM_ID);
        const mintToIx = createMintToInstruction(feeMint, ata, payer.publicKey, BigInt(10_000e9), [], TOKEN_2022_PROGRAM_ID);
        await sendAndConfirm(new Transaction().add(createAtaIx, mintToIx), [payer]);
        return user;
    }

    const redeemerA = await fundRedeemer();
    const redeemerB = await fundRedeemer();

    const vaultAta = getAssociatedTokenAddressSync(feeMint, pdas.redemptionVaultAuthorityPda, true, TOKEN_2022_PROGRAM_ID);
    const createVaultAtaIx = createAssociatedTokenAccountInstruction(payer.publicKey, vaultAta, pdas.redemptionVaultAuthorityPda, feeMint, TOKEN_2022_PROGRAM_ID);
    await sendAndConfirm(new Transaction().add(createVaultAtaIx), [payer]);

    console.log("\nStep 1: two ordinary, unrelated redeemers each create a redemption request for", GROSS_AMOUNT);
    await program.methods.createRedemptionRequest(new BN(GROSS_AMOUNT)).accounts({
        redemptionOffer: redemptionOfferPda, redeemer: redeemerA.publicKey, tokenInMint: feeMint, tokenProgram: TOKEN_2022_PROGRAM_ID,
    }).signers([redeemerA]).rpc({ skipPreflight: true });
    await program.methods.createRedemptionRequest(new BN(GROSS_AMOUNT)).accounts({
        redemptionOffer: redemptionOfferPda, redeemer: redeemerB.publicKey, tokenInMint: feeMint, tokenProgram: TOKEN_2022_PROGRAM_ID,
    }).signers([redeemerB]).rpc({ skipPreflight: true });
    console.log("  OK  both create_redemption_request calls succeeded (no fee-guard rejection anywhere)");

    const vaultAfterDeposits = await getTokenAccountBalance(vaultAta);
    const expectedNet = BigInt(GROSS_AMOUNT) - MAX_FEE;
    assertEqual(vaultAfterDeposits, expectedNet * BigInt(2), "vault balance after 2 deposits = 2x(gross-fee), NOT 2x gross");

    const redemptionOfferAccount = await program.account.redemptionOffer.fetch(redemptionOfferPda);
    assertEqual(redemptionOfferAccount.requestedRedemptions.toString(), (GROSS_AMOUNT * 2).toString(), "requested_redemptions records the GROSS (pre-fee) total");

    const recordedObligation = BigInt(GROSS_AMOUNT) * BigInt(2);
    if (!(recordedObligation > vaultAfterDeposits)) throw new Error("ASSERTION FAILED: solvency invariant should already be broken here");
    console.log(`  OK  solvency invariant already broken: recorded obligation ${recordedObligation} > actual vault balance ${vaultAfterDeposits}`);

    console.log("\nStep 2: redeemer A (honest, first-mover) cancels their own pending request");
    const reqA = getRedemptionRequestPda(redemptionOfferPda, 0);
    await program.methods.cancelRedemptionRequest().accounts({
        redemptionOffer: redemptionOfferPda, redemptionRequest: reqA, signer: redeemerA.publicKey,
        tokenInMint: feeMint, redeemer: redeemerA.publicKey, redemptionAdmin: redemptionAdmin.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
    }).signers([redeemerA]).rpc({ skipPreflight: true });
    const vaultAfterACancel = await getTokenAccountBalance(vaultAta);
    assertEqual(vaultAfterACancel, vaultAfterDeposits - BigInt(GROSS_AMOUNT), "vault debited the full GROSS amount on A's cancel, not the net A actually contributed");

    console.log("\nStep 3: redeemer B (entirely honest, did nothing wrong) tries to cancel their own still-pending request");
    const reqB = getRedemptionRequestPda(redemptionOfferPda, 1);
    let bFailed = false, bErr = "";
    try {
        await program.methods.cancelRedemptionRequest().accounts({
            redemptionOffer: redemptionOfferPda, redemptionRequest: reqB, signer: redeemerB.publicKey,
            tokenInMint: feeMint, redeemer: redeemerB.publicKey, redemptionAdmin: redemptionAdmin.publicKey,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
        }).signers([redeemerB]).rpc({ skipPreflight: true });
    } catch (err) {
        bFailed = true;
        bErr = err instanceof Error ? err.message : String(err);
    }

    if (!bFailed) throw new Error("ASSERTION FAILED (finding NOT reproduced): B's cancel unexpectedly succeeded — vault was NOT insolvent as hypothesized");
    console.log(`  OK  B's cancel FAILED as predicted: ${bErr.slice(0, 300)}`);

    console.log("\n================ PoC CONFIRMED — real compiled onreapp.so, real anchor.Program, real LiteSVM execution ================");
    console.log(`Vault balance after A's ordinary, allowed cancel: ${vaultAfterACancel}`);
    console.log(`B's own recorded redemption amount (what B is owed): ${GROSS_AMOUNT}`);
    console.log(`Shortfall B cannot recover: ${BigInt(GROSS_AMOUNT) - vaultAfterACancel}`);
    console.log("No malice, no timing attack, no admin misbehavior — only an ordinary Token-2022 fee-bearing mint used as redemption token_in, which the code never rejects (unlike the sibling take_offer path).");
}

main().then(() => {
    console.log("\nPoC SUCCEEDED end-to-end.");
    process.exit(0);
}).catch((err) => {
    console.error("\nPoC FAILED:");
    console.error(err);
    process.exit(1);
});
