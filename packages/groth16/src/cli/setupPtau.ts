import path from "path";

import { SETUP_DIR } from "../constants";
import { assertSnarkjsInstalled, localSnarkjsBinary, runOrThrow, setupDirectories } from "./shared";

setupDirectories();
assertSnarkjsInstalled();

const snarkjs = localSnarkjsBinary();
const initialPtau = path.join(SETUP_DIR, "powersOfTau28_hez_dev_0000.ptau");
const contributedPtau = path.join(SETUP_DIR, "powersOfTau28_hez_dev_0001.ptau");
const finalPtau = path.join(SETUP_DIR, "powersOfTau28_hez_dev_final.ptau");

runOrThrow(snarkjs, ["powersoftau", "new", "bn128", "16", initialPtau, "-v"]);
runOrThrow(snarkjs, [
  "powersoftau",
  "contribute",
  initialPtau,
  contributedPtau,
  "--name=polyshield-dev",
  "-e=polyshield-dev-entropy",
]);
runOrThrow(snarkjs, ["powersoftau", "prepare", "phase2", contributedPtau, finalPtau, "-v"]);
