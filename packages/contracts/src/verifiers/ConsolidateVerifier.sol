// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerifier} from "../interfaces/IVerifier.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin-upgradeable/access/OwnableUpgradeable.sol";

// snarkJS-generated Groth16 verifier — consolidate circuit (6 public signals).
// The <Name>G16Base contract below is generated; the <Name>Verifier adapter is UUPS-upgradeable.
// Regenerate via Benchmarking/groth16 (pnpm generate:verifiers). Do not edit by hand.
contract ConsolidateG16Base {
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
    uint256 constant deltax1 = 16579661862752361306399100221654451382553015578791126381484093144294569390564;
    uint256 constant deltax2 = 20906721363096198216558096122135981359392876989233807759073004237099469101693;
    uint256 constant deltay1 = 2090948755591328394229083037342660961242182766649348503028120592436785540996;
    uint256 constant deltay2 = 19933254059805789111544303560543522047899431484294831674219472956351533465327;

    
    uint256 constant IC0x = 5231224240484466615728176676874935392284358050257101083986507004766638265123;
    uint256 constant IC0y = 20307172716056677842578125460796960193483771213272234427437244718920946937805;
    
    uint256 constant IC1x = 3351895257951658453094580418145120102124694028822726322465754755780063795694;
    uint256 constant IC1y = 16574410336819778788730913969081900237327184176997911071023768538757148462992;
    
    uint256 constant IC2x = 17205874653243839877346818007197340089429028268456248620904489070273619173982;
    uint256 constant IC2y = 8010745342424876120807099355848481251292108443905736048287887669089905670265;
    
    uint256 constant IC3x = 15781051029910954260838382094812140012043235031650391736514398660951889080229;
    uint256 constant IC3y = 12431780634498585975412163902495788745150050362171555502188982043683489263403;
    
    uint256 constant IC4x = 3730228020648232761466702674046977958372593643958614871330054444891547644074;
    uint256 constant IC4y = 12745456102550925443614125983735829127435134468900095161208360507884233784035;
    
    uint256 constant IC5x = 3414137352108054617894661370030319444292236176073715645213468248952328956363;
    uint256 constant IC5y = 14293597405026970653434429730516728419389748832397591719024962483243321334766;
    
    uint256 constant IC6x = 2867093918651925640172576948317572894949258401299032668013032299594031575226;
    uint256 constant IC6y = 13869854016319756153451715377498149571340430102148867769544109973183269412897;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[6] calldata _pubSignals) public view returns (bool) {
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
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                

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
            
            checkField(calldataload(add(_pubSignals, 160)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }


/// @notice UUPS-upgradeable IVerifier adapter for the Groth16 Consolidate circuit.
/// Proof encoding: abi.encode(uint256[2] pA, uint256[2][2] pB, uint256[2] pC) — 256 bytes.
/// Deployed behind an ERC1967Proxy; initialize(owner) deploys the ConsolidateG16Base.
/// VK re-key: deploy a new ConsolidateG16Base and call setBase(); adapter-logic change:
/// upgradeToAndCall to a new implementation.
contract ConsolidateVerifier is Initializable, UUPSUpgradeable, OwnableUpgradeable, IVerifier {
    address public base; // ConsolidateG16Base, in proxy storage
    uint256[49] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) external initializer {
        __Ownable_init(owner_);
        base = address(new ConsolidateG16Base());
    }

    /// @notice Adopt a freshly deployed base (new VK) without a full proxy migration. Owner-only.
    function setBase(address newBase) external onlyOwner {
        base = newBase;
    }

    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool) {
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) =
            abi.decode(proof, (uint256[2], uint256[2][2], uint256[2]));
        uint256[6] memory sigs;
        for (uint256 i = 0; i < 6; i++) {
            sigs[i] = uint256(publicInputs[i]);
        }
        return ConsolidateG16Base(base).verifyProof(pA, pB, pC, sigs);
    }

    /// @notice UUPS upgrade authorization. Owner-gated, instant (no timelock).
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
