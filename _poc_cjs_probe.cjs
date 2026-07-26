// Load the EXACT same package set as test_helper.ts + onre_program.ts, in plain CJS,
// to isolate: is the crash caused by a package-combination conflict (e.g. anchor + litesvm),
// or is it specific to tsx's transpilation of their .ts files?
console.log("requiring all packages used by test_helper.ts + onre_program.ts...");
const { LiteSVM, FeatureSet, ComputeBudget } = require("litesvm");
const {
    ACCOUNT_SIZE, AccountLayout, getAssociatedTokenAddressSync, MINT_SIZE, MintLayout,
    TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ExtensionType, getMintLen,
    createInitializeMint2Instruction, createInitializeTransferFeeConfigInstruction,
    createAssociatedTokenAccountInstruction, createMintToInstruction,
} = require("@solana/spl-token");
const { Keypair, PublicKey, SystemProgram, Transaction } = require("@solana/web3.js");
const { AnchorProvider, BN, Program, Wallet } = require("@coral-xyz/anchor");
const idl = require("./target/idl/onreapp.json");
console.log("OK — all packages required without crashing.");

console.log("instantiating LiteSVM with featureSet+precompiles...");
const svm = new LiteSVM().withFeatureSet(FeatureSet.allEnabled()).withPrecompiles();
console.log("OK — LiteSVM instantiated with the FULL package set loaded alongside it.");

const payer = Keypair.generate();
svm.airdrop(payer.publicKey, BigInt(100_000_000_000));
console.log("OK — airdrop succeeded.");

const wallet = new Wallet(payer);
const provider = new AnchorProvider(
    { getLatestBlockhash: async () => ({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: 0 }) },
    wallet,
    { commitment: "processed" }
);
console.log("about to instantiate anchor Program (this is the one thing my minimal probe never touched)...");
const program = new Program(idl, provider);
console.log("OK — anchor Program instantiated successfully. Crash is NOT here either.");
