// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerifier} from "../interfaces/IVerifier.sol";

// snarkJS-generated Groth16 verifier — settlement_credit circuit (6 public signals)
// Source: Benchmarking/groth16/contracts/generated/SettlementCreditVerifier.sol
contract SettlementCreditG16Base {
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
    uint256 constant deltax1 = 16503963902567144021389338224641361160234665547459113733966852221414790568653;
    uint256 constant deltax2 = 18189994018769881666714013663877181220829431814562841628862372426826226284004;
    uint256 constant deltay1 = 15574446705744065203027486017702284248726853522386449912693340908620357771849;
    uint256 constant deltay2 = 19170685794734803067374269615197015552648854453389219806703662991439133557752;

    uint256 constant IC0x = 6736785615289479620377631480721949407214749597820931388569163899179956840026;
    uint256 constant IC0y = 10014028195584126041928923993428359322898819689304899931451534023452546244465;
    uint256 constant IC1x = 12753494073117694049074421931732023972522119248861288981631419922332141639506;
    uint256 constant IC1y = 18088034172849879373905514613156648807440226885814749913351200937577766058961;
    uint256 constant IC2x = 21442408394120667410262660833539777173952262879869478325879552402464659668806;
    uint256 constant IC2y = 9992742812870144036312730222252432861126287777157247103108800418353069053856;
    uint256 constant IC3x = 16488912408270893967657939239722750226982625664843190722822744925997844005966;
    uint256 constant IC3y = 6027605001740277263530865397955429682935152070569785911244783326650595305542;
    uint256 constant IC4x = 12692753335691798121104755167751157863036404829572633553577706042032057036002;
    uint256 constant IC4y = 3419003758861193304793636836350440841287190239551898277484278361549541039503;
    uint256 constant IC5x = 2321814912154023828619804352287851668336470856842027800871737159030185491676;
    uint256 constant IC5y = 18717655888470198503874952917696904610918271211979511053717858902582527223503;
    uint256 constant IC6x = 2886644958471074690902711281721659933803999410474289330302872792331344468870;
    uint256 constant IC6y = 18696415866236105956533800674697846008458170316705777817990203254119020906963;

    uint16 constant pVk      = 0;
    uint16 constant pPairing = 128;
    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[6] calldata _pubSignals) public view returns (bool) {
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
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
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
            checkField(calldataload(add(_pubSignals, 160)))
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)
            mstore(0, isValid)
            return(0, 0x20)
        }
    }
}

/// @notice IVerifier adapter for the Groth16 settlement_credit circuit.
/// Proof encoding: abi.encode(uint256[2] pA, uint256[2][2] pB, uint256[2] pC) — 256 bytes.
contract SettlementCreditVerifier is IVerifier {
    SettlementCreditG16Base private immutable _base;

    constructor() {
        _base = new SettlementCreditG16Base();
    }

    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool) {
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) =
            abi.decode(proof, (uint256[2], uint256[2][2], uint256[2]));
        uint256[6] memory sigs;
        for (uint256 i = 0; i < 6; i++) {
            sigs[i] = uint256(publicInputs[i]);
        }
        return _base.verifyProof(pA, pB, pC, sigs);
    }
}
