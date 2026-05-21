"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = __importDefault(require("path"));
const constants_1 = require("../constants");
const shared_1 = require("./shared");
(0, shared_1.setupDirectories)();
(0, shared_1.assertSnarkjsInstalled)();
const snarkjs = (0, shared_1.localSnarkjsBinary)();
const initialPtau = path_1.default.join(constants_1.SETUP_DIR, "powersOfTau28_hez_dev_0000.ptau");
const finalPtau = path_1.default.join(constants_1.SETUP_DIR, "powersOfTau28_hez_dev_final.ptau");
(0, shared_1.runOrThrow)(snarkjs, ["powersoftau", "new", "bn128", "12", initialPtau, "-v"]);
(0, shared_1.runOrThrow)(snarkjs, ["powersoftau", "contribute", initialPtau, finalPtau, "--name=polyshield-dev", "-e=polyshield-dev-entropy"]);
//# sourceMappingURL=setupPtau.js.map