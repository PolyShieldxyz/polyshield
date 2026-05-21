"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CIRCUIT_INPUT_LENGTHS = exports.CIRCUIT_IDS = exports.GENERATED_CONTRACTS_DIR = exports.CONTRACTS_DIR = exports.SETUP_DIR = exports.ARTIFACTS_DIR = exports.CIRCUITS_DIR = exports.PACKAGE_ROOT = exports.BN254_SCALAR_FIELD = void 0;
const path_1 = __importDefault(require("path"));
exports.BN254_SCALAR_FIELD = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");
exports.PACKAGE_ROOT = path_1.default.resolve(__dirname, "..");
exports.CIRCUITS_DIR = path_1.default.join(exports.PACKAGE_ROOT, "circuits");
exports.ARTIFACTS_DIR = path_1.default.join(exports.PACKAGE_ROOT, "artifacts");
exports.SETUP_DIR = path_1.default.join(exports.PACKAGE_ROOT, "setup");
exports.CONTRACTS_DIR = path_1.default.join(exports.PACKAGE_ROOT, "contracts");
exports.GENERATED_CONTRACTS_DIR = path_1.default.join(exports.CONTRACTS_DIR, "generated");
exports.CIRCUIT_IDS = [
    "bet_auth",
    "settlement_credit",
    "withdrawal",
    "bet_cancel",
    "cancel_credit",
];
exports.CIRCUIT_INPUT_LENGTHS = {
    bet_auth: 9,
    settlement_credit: 8,
    withdrawal: 4,
    bet_cancel: 5,
    cancel_credit: 6,
};
//# sourceMappingURL=constants.js.map