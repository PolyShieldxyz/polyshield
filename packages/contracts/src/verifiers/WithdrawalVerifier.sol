// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerifier} from "../interfaces/IVerifier.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin-upgradeable/access/OwnableUpgradeable.sol";

// snarkJS-generated Groth16 verifier — withdrawal circuit (5 public signals).
// The <Name>G16Base contract below is generated; the <Name>Verifier adapter is UUPS-upgradeable.
// Regenerate via Benchmarking/groth16 (pnpm generate:verifiers). Do not edit by hand.
contract WithdrawalG16Base {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 15973749208221913472688076038629166378250190189699598293210292650663254699502;
    uint256 constant deltax2 = 10470650093297363521117754272689054277606482338906534975269971933860389181879;
    uint256 constant deltay1 = 20821567561145967143632814228709117800238343174054994328927270977414670430096;
    uint256 constant deltay2 = 20335621685146892396228588139497785826237849403850029957154049428068825112123;

    
    uint256 constant IC0x = 3779998562702365612690756867936589939430219312273928371467423681441102184955;
    uint256 constant IC0y = 19842866122863088995040728461573405018257518250161477742480511994115742125764;
    
    uint256 constant IC1x = 16193900946428633174569535024794510025204310955807640839248347090614933519206;
    uint256 constant IC1y = 11250834470845289448448199030403211472655811109606469404101662846576676000775;
    
    uint256 constant IC2x = 8927448790706294801129542852277389978091538125140502409705259001657800610724;
    uint256 constant IC2y = 21003284139526353356900182188282854541472844805200552831893311221568437628753;
    
    uint256 constant IC3x = 5237996124302216805074062921925604469256808259228605300971651483163164093721;
    uint256 constant IC3y = 11532937724580853296858586843121116549263045202056696561895539874245399636621;
    
    uint256 constant IC4x = 20088507558292478231019686971577069053576837768325260914093839247867026985195;
    uint256 constant IC4y = 16147777937867885500357393688378970900749984790633797031277249721729566199399;
    
    uint256 constant IC5x = 16555090647152309743226262250033977363633917261214363952042246627066126128255;
    uint256 constant IC5y = 10772931439075084254405084440561156980634089570348591833555549693940839410734;
    
 
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


/// @notice UUPS-upgradeable IVerifier adapter for the Groth16 Withdrawal circuit.
/// Proof encoding: abi.encode(uint256[2] pA, uint256[2][2] pB, uint256[2] pC) — 256 bytes.
/// Deployed behind an ERC1967Proxy; initialize(owner) deploys the WithdrawalG16Base.
/// VK re-key: deploy a new WithdrawalG16Base and call setBase(); adapter-logic change:
/// upgradeToAndCall to a new implementation.
contract WithdrawalVerifier is Initializable, UUPSUpgradeable, OwnableUpgradeable, IVerifier {
    address public base; // WithdrawalG16Base, in proxy storage
    uint256[49] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) external initializer {
        __Ownable_init(owner_);
        base = address(new WithdrawalG16Base());
    }

    /// @notice Adopt a freshly deployed base (new VK) without a full proxy migration. Owner-only.
    function setBase(address newBase) external onlyOwner {
        base = newBase;
    }

    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool) {
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) =
            abi.decode(proof, (uint256[2], uint256[2][2], uint256[2]));
        uint256[5] memory sigs;
        for (uint256 i = 0; i < 5; i++) {
            sigs[i] = uint256(publicInputs[i]);
        }
        return WithdrawalG16Base(base).verifyProof(pA, pB, pC, sigs);
    }

    /// @notice UUPS upgrade authorization. Owner-gated, instant (no timelock).
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
