// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerifier} from "../interfaces/IVerifier.sol";

// snarkJS-generated Groth16 verifier — bet_auth circuit (9 public signals)
// Source: Benchmarking/groth16/contracts/generated/BetAuthVerifier.sol
contract BetAuthG16Base {
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
    uint256 constant deltax1 = 4149391023745155271582710417079464809025988898521135063648917652441937210873;
    uint256 constant deltax2 = 481915314291981539248855906684734167534534160453347951882621280814782377994;
    uint256 constant deltay1 = 1414801478540205763239806908145727608682953359991817346439273390025198321852;
    uint256 constant deltay2 = 385469187427121600330818085829176198577408945598432430693219090072445411730;

    uint256 constant IC0x = 20060264494204526373107170715841951437085423590601214035299752688257309211230;
    uint256 constant IC0y = 510119925333428459817212307670923286021877493387871001127016542556683584851;
    uint256 constant IC1x = 20441845054816452061946103251136232165670645848917453583036171023604444362648;
    uint256 constant IC1y = 463211360236885607673126586824656605925893376736809020000243321705448844409;
    uint256 constant IC2x = 1657701054000750895729217508962809737398017950845133789617976272260812133719;
    uint256 constant IC2y = 7387603338916321649039175416518306450331700249256338147380833684774540522885;
    uint256 constant IC3x = 4514564145349426366308704194431604881909761688619536028354772075945897681940;
    uint256 constant IC3y = 3992957937955226887219560166908871077725887417878591476545563527454775761276;
    uint256 constant IC4x = 13550083190880030757877888929974564851315002579802478573686726987026655916978;
    uint256 constant IC4y = 9736301364081438353788989211632323975971021861831973894998399202916632942117;
    uint256 constant IC5x = 19615155718551743111405567339647846012155710606810535091168030410894417214449;
    uint256 constant IC5y = 9583070810513822285551333623635985598719839119145722648968836014539518135449;
    uint256 constant IC6x = 17754390923154784083374561998632442539097227048247872831117180602226847858123;
    uint256 constant IC6y = 16928806878188393679464802419033938186443394983942890778808178742608132028639;
    uint256 constant IC7x = 5459771560754300118484217211902393021288333351343538202520717072165560370388;
    uint256 constant IC7y = 20144754839067034801095058849414325462387048893408806912872129242429730720852;
    uint256 constant IC8x = 9784321085466721833160982408876644090952490897759396276691281385373135349647;
    uint256 constant IC8y = 1524020863849348217001229736230590120594010348836372476011528961243662787464;
    uint256 constant IC9x = 12632965252665110973951927767969967358140750044558615250786408108407407172974;
    uint256 constant IC9y = 21130420286321186481706531411642313170148511788148671257584930614038916699230;

    uint16 constant pVk      = 0;
    uint16 constant pPairing = 128;
    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[9] calldata _pubSignals) public view returns (bool) {
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
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
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
            checkField(calldataload(add(_pubSignals, 192)))
            checkField(calldataload(add(_pubSignals, 224)))
            checkField(calldataload(add(_pubSignals, 256)))
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)
            mstore(0, isValid)
            return(0, 0x20)
        }
    }
}

/// @notice IVerifier adapter for the Groth16 bet_auth circuit.
/// Proof encoding: abi.encode(uint256[2] pA, uint256[2][2] pB, uint256[2] pC) — 256 bytes.
contract BetAuthVerifier is IVerifier {
    BetAuthG16Base private immutable _base;

    constructor() {
        _base = new BetAuthG16Base();
    }

    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool) {
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) =
            abi.decode(proof, (uint256[2], uint256[2][2], uint256[2]));
        uint256[9] memory sigs;
        for (uint256 i = 0; i < 9; i++) {
            sigs[i] = uint256(publicInputs[i]);
        }
        return _base.verifyProof(pA, pB, pC, sigs);
    }
}
