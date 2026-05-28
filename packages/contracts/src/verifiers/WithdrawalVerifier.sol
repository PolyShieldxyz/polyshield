// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerifier} from "../interfaces/IVerifier.sol";

// snarkJS-generated Groth16 verifier — withdrawal circuit (5 public signals)
// Source: Benchmarking/groth16/contracts/generated/WithdrawalVerifier.sol
contract WithdrawalG16Base {
    uint256 constant r = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 constant q = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    uint256 constant alphax  = 19740989070065691168024417833765351201611573416695136994411305842600501570246;
    uint256 constant alphay  = 7217249632034699012845897563931166334124016775981189044441743872137449040931;
    uint256 constant betax1  = 2130351525125202068219330047588646655421230172909351791343531996293155611824;
    uint256 constant betax2  = 16866004719338026599381799314714282367309086805222944600233651483292342625480;
    uint256 constant betay1  = 2200179990033717203849243015439574198487328537910282568297956808394269866549;
    uint256 constant betay2  = 20668351268379870143640438345945213553584484760756537432840023603878518225260;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 15838677662836908002694300255997932487838388224627676633416467088296258021505;
    uint256 constant deltax2 = 8430985364297393283449124844672088928492918241804076454854566477472094838448;
    uint256 constant deltay1 = 19665526388967017385201299143510970865665590378479140914352057868519891829617;
    uint256 constant deltay2 = 8832946967438436235672032080712518332166946744317569928432651834431322939601;

    uint256 constant IC0x = 13466995708912513977462119238548705571863804061773646663709507347711897113658;
    uint256 constant IC0y = 17138582198048948788668746966478282920729364100042417499228143607221315763191;
    uint256 constant IC1x = 6840900902624084136422020471789226453318758410994071961865727072620215242751;
    uint256 constant IC1y = 17108691652951400732016110585815120488720479657234553578919782093471568522044;
    uint256 constant IC2x = 17314042601353951797733070028289033176888043127333589087555500983240667854843;
    uint256 constant IC2y = 11831581990424291387121868987160399765976349189925087033669567649587740408541;
    uint256 constant IC3x = 1426956802973052149265113799986968980519782149238041570501254963207510149900;
    uint256 constant IC3y = 20284249368435590976050495767163351329366727472848350025993777713225687724379;
    uint256 constant IC4x = 16694623534184212958483992038834770698104260507463303567585862595673583085288;
    uint256 constant IC4y = 7392552667550482784289078346440314760688327442239566525139628102472507228064;
    uint256 constant IC5x = 2271931307678143867866048243776265465176844654373860155328542855735365668710;
    uint256 constant IC5y = 5553690489482095092208237696795140311594704218747824182012570638186167885748;

    uint16 constant pVk      = 0;
    uint16 constant pPairing = 128;
    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[5] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) { mstore(0, 0) return(0, 0x20) }
            }
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x) mstore(add(mIn, 32), y) mstore(add(mIn, 64), s)
                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)
                if iszero(success) { mstore(0, 0) return(0, 0x20) }
                mstore(add(mIn, 64), mload(pR)) mstore(add(mIn, 96), mload(add(pR, 32)))
                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)
                if iszero(success) { mstore(0, 0) return(0, 0x20) }
            }
            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)
                mstore(_pVk, IC0x) mstore(add(_pVk, 32), IC0y)
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals,   0)))
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals,  32)))
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals,  64)))
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals,  96)))
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing,  32), mod(sub(q, calldataload(add(pA, 32))), q))
                mstore(add(_pPairing,  64), calldataload(pB))
                mstore(add(_pPairing,  96), calldataload(add(pB,  32)))
                mstore(add(_pPairing, 128), calldataload(add(pB,  64)))
                mstore(add(_pPairing, 160), calldataload(add(pB,  96)))
                mstore(add(_pPairing, 192), alphax) mstore(add(_pPairing, 224), alphay)
                mstore(add(_pPairing, 256), betax1) mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1) mstore(add(_pPairing, 352), betay2)
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))
                mstore(add(_pPairing, 448), gammax1) mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1) mstore(add(_pPairing, 544), gammay2)
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))
                mstore(add(_pPairing, 640), deltax1) mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1) mstore(add(_pPairing, 736), deltay2)
                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)
                isOk := and(success, mload(_pPairing))
            }
            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))
            checkField(calldataload(add(_pubSignals,   0)))
            checkField(calldataload(add(_pubSignals,  32)))
            checkField(calldataload(add(_pubSignals,  64)))
            checkField(calldataload(add(_pubSignals,  96)))
            checkField(calldataload(add(_pubSignals, 128)))
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)
            mstore(0, isValid)
            return(0, 0x20)
        }
    }
}

/// @notice IVerifier adapter for the Groth16 withdrawal circuit.
/// Proof encoding: abi.encode(uint256[2] pA, uint256[2][2] pB, uint256[2] pC) — 256 bytes.
contract WithdrawalVerifier is IVerifier {
    WithdrawalG16Base private immutable _base;

    constructor() {
        _base = new WithdrawalG16Base();
    }

    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool) {
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) =
            abi.decode(proof, (uint256[2], uint256[2][2], uint256[2]));
        uint256[5] memory sigs;
        for (uint256 i = 0; i < 5; i++) {
            sigs[i] = uint256(publicInputs[i]);
        }
        return _base.verifyProof(pA, pB, pC, sigs);
    }
}
