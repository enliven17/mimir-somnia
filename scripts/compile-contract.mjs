/**
 * Compile contracts/*.sol with the settings the deployed bytecode was produced
 * under. Writes ABI + bytecode to deploy/artifacts/.
 *
 *   node scripts/compile-contract.mjs MimirV2
 *
 * viaIR is required, not a preference: the create flow exceeds stack depth
 * without it. Changing optimizer runs or viaIR changes the bytecode, which
 * breaks verification against an already-deployed address.
 */
import solc from "solc";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("usage: node scripts/compile-contract.mjs <ContractName...>");
  process.exit(1);
}

const sources = {};
for (const name of targets) {
  sources[`${name}.sol`] = { content: readFileSync(`contracts/${name}.sol`, "utf8") };
}

const out = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources,
      settings: {
        optimizer: { enabled: true, runs: 200 },
        viaIR: true,
        outputSelection: {
          "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] },
        },
      },
    }),
  ),
);

const errors = (out.errors ?? []).filter((e) => e.severity === "error");
if (errors.length > 0) {
  for (const error of errors) console.error(error.formattedMessage);
  process.exit(1);
}
for (const warning of out.errors ?? []) {
  if (warning.severity !== "error") console.warn(warning.formattedMessage.split("\n")[0]);
}

mkdirSync("deploy/artifacts", { recursive: true });
for (const name of targets) {
  const contract = out.contracts[`${name}.sol`][name];
  const artifact = {
    contractName: name,
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}`,
    deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
    compiler: { version: solc.version(), optimizer: { enabled: true, runs: 200 }, viaIR: true },
  };
  writeFileSync(`deploy/artifacts/${name}.json`, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(
    `${name}: ${contract.evm.deployedBytecode.object.length / 2} bytes runtime, ` +
      `${contract.abi.filter((e) => e.type === "function").length} functions`,
  );
}
