console.log("requiring litesvm via CJS...");
const { LiteSVM, FeatureSet } = require("litesvm");
console.log("instantiating LiteSVM with featureSet+precompiles (matches TestHelper.create())...");
const svm = new LiteSVM().withFeatureSet(FeatureSet.allEnabled()).withPrecompiles();
console.log("OK — instantiated with feature set.");

const fs = require("fs");
const path = require("path");
const { PublicKey } = require("@solana/web3.js");

const programPath = path.join(process.cwd(), "target/deploy/onreapp.so");
console.log("reading program bytes from", programPath);
const programBytes = fs.readFileSync(programPath);
console.log("program bytes length:", programBytes.length);

const BPF_UPGRADEABLE_LOADER_PROGRAM_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const idl = require("./target/idl/onreapp.json");
const ONREAPP_PROGRAM_ID = new PublicKey(idl.address);

const programDataPda = PublicKey.findProgramAddressSync(
    [ONREAPP_PROGRAM_ID.toBuffer()],
    BPF_UPGRADEABLE_LOADER_PROGRAM_ID
)[0];
console.log("programDataPda derived:", programDataPda.toBase58());

const programDataAccountData = Buffer.alloc(45 + programBytes.length);
programDataAccountData.writeUInt32LE(3, 0);
programDataAccountData.writeBigUInt64LE(BigInt(0), 4);
programDataAccountData.writeUInt8(1, 12);
programBytes.copy(programDataAccountData, 45);

console.log("about to svm.setAccount() with the full program bytecode buffer (this is the step my minimal probe never exercised)...");
svm.setAccount(programDataPda, {
    executable: false,
    data: programDataAccountData,
    lamports: 10_000_000,
    owner: BPF_UPGRADEABLE_LOADER_PROGRAM_ID
});
console.log("OK — setAccount with full program bytecode succeeded. Crash is NOT here.");
