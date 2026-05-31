// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerifier} from "../interfaces/IVerifier.sol";

// snarkJS-generated Groth16 verifier — PositionClose circuit (5 public signals)
// Source: Benchmarking/groth16/contracts/generated/PositionCloseVerifier.sol (regenerate via Benchmarking/groth16)
contract PositionCloseG16Base {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
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
    uint256 constant deltax1 = 21485213523061135936338577473540783268719276044938924315392219052027868622079;
    uint256 constant deltax2 = 13191912943263199388075157178563999703055357483138670226345033195546328150995;
    uint256 constant deltay1 = 20723767978228264894947376296182551097783868912116815507202517293845277784133;
    uint256 constant deltay2 = 20798138475771201026392519149454444480429648300193015431852322284368777369949;

    
    uint256 constant IC0x = 18604488857059536026149878744300760548837690375962502533591434728396755269404;
    uint256 constant IC0y = 2530213823447528143725772056702476397509305683140858628524129922478244041659;
    
    uint256 constant IC1x = 3425020739488838148616938455626721937972125048258066913212538187839270989435;
    uint256 constant IC1y = 17223185325354503128609624995307653359309167735799309585253501968093414099873;
    
    uint256 constant IC2x = 21593765773382756311562422635749451727286327291856846047386980840441770092806;
    uint256 constant IC2y = 11880148357852624070597838219235309830178468088614114724050922024607280821631;
    
    uint256 constant IC3x = 13929368561375031296570302874237999664110401513840417385873200675538957267404;
    uint256 constant IC3y = 8866858226023560398980560399421417183318534254057985860947185930677469798444;
    
    uint256 constant IC4x = 19911887871766850951516402710616840390782750578285485432981507677625131452278;
    uint256 constant IC4y = 731352851832479214963410552001191600437086677524418440266821709695028376358;
    
    uint256 constant IC5x = 18622269039700615916816534410112049554944384920564923621420120402063876923869;
    uint256 constant IC5y = 6434052505503675674148095815566744555135061251719689101708484884645851307928;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[5] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }

/// @notice IVerifier adapter for the Groth16 PositionClose circuit.
/// Proof encoding: abi.encode(uint256[2] pA, uint256[2][2] pB, uint256[2] pC) — 256 bytes.
contract PositionCloseVerifier is IVerifier {
    PositionCloseG16Base private immutable _base;

    constructor() {
        _base = new PositionCloseG16Base();
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
