// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerifier} from "../interfaces/IVerifier.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin-upgradeable/access/OwnableUpgradeable.sol";

// snarkJS-generated Groth16 verifier — bet_auth circuit (10 public signals).
// The <Name>G16Base contract below is generated; the <Name>Verifier adapter is UUPS-upgradeable.
// Regenerate via Benchmarking/groth16 (pnpm generate:verifiers). Do not edit by hand.
contract BetAuthG16Base {
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
    uint256 constant deltax1 = 20607296271296611552282261806884509644592486028575671555601175357906940734874;
    uint256 constant deltax2 = 11194458713655275796072809270713343732255020246232684894752257111981580045028;
    uint256 constant deltay1 = 2756446175273778465625573825726443505980323494118158120446770698076025692340;
    uint256 constant deltay2 = 15509928471427012370033709916772742802099962016216884139337167264416543881321;

    
    uint256 constant IC0x = 14015473354475364157938137586709443218015116193185770504405659070674340080483;
    uint256 constant IC0y = 2854636184834517469661341552502570629102726908382302292386365967939616485182;
    
    uint256 constant IC1x = 14718006872986742108323362738299541289346168428268744870068067783376596643222;
    uint256 constant IC1y = 85054386162150886509389859213829182105994341813076773667487914264034016900;
    
    uint256 constant IC2x = 17266936410554967592970701529739053552722796294452972137639958307848422662879;
    uint256 constant IC2y = 17554441076717952346843120207200747755481960907221510603476512102336607149416;
    
    uint256 constant IC3x = 17769570753099522676584889577909042255181612332553778211856797859500979973471;
    uint256 constant IC3y = 6725264849124885997655475125125572993315285784714284968811791891818451999706;
    
    uint256 constant IC4x = 15379942413572252126240378848307360032971317906350981353049702068156863631846;
    uint256 constant IC4y = 18858069081204598353137587465137712622046751081368131822202946947242157371371;
    
    uint256 constant IC5x = 6749050952480423703075689804226239948246150735237177348933292762952140815357;
    uint256 constant IC5y = 13923180419818784028627233849763343186691640939380087919981885584679009086974;
    
    uint256 constant IC6x = 10057861036126731263331834509946959525477639417809386540579903381355272078702;
    uint256 constant IC6y = 9688334139351270487467336031633275391485195066774214861517998510491043268451;
    
    uint256 constant IC7x = 12196668996924242320176852033378044869758164502233246488260451405913585567093;
    uint256 constant IC7y = 16277162668201162413718141904122977946532937799008096346577072530413555329812;
    
    uint256 constant IC8x = 6705656183042395196049987218292239551766904951947131697869690276371613484984;
    uint256 constant IC8y = 5286760021318800222916698804913668612222626338439476973377292644998513495972;
    
    uint256 constant IC9x = 4012968736554216120282243022335270965512622448998108063946599882976400837655;
    uint256 constant IC9y = 9905106595240552085812828840261011950931490745845051394294390805951980633604;
    
    uint256 constant IC10x = 16253209034199989077926324486940009309546519466618795203693886489671130360525;
    uint256 constant IC10y = 21348320989463776864862879173633589944519659720905658334405788643360752643112;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[10] calldata _pubSignals) public view returns (bool) {
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
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                

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
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }


/// @notice UUPS-upgradeable IVerifier adapter for the Groth16 BetAuth circuit.
/// Proof encoding: abi.encode(uint256[2] pA, uint256[2][2] pB, uint256[2] pC) — 256 bytes.
/// Deployed behind an ERC1967Proxy; initialize(owner) deploys the BetAuthG16Base.
/// VK re-key: deploy a new BetAuthG16Base and call setBase(); adapter-logic change:
/// upgradeToAndCall to a new implementation.
contract BetAuthVerifier is Initializable, UUPSUpgradeable, OwnableUpgradeable, IVerifier {
    address public base; // BetAuthG16Base, in proxy storage
    uint256[49] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) external initializer {
        __Ownable_init(owner_);
        base = address(new BetAuthG16Base());
    }

    /// @notice Adopt a freshly deployed base (new VK) without a full proxy migration. Owner-only.
    function setBase(address newBase) external onlyOwner {
        base = newBase;
    }

    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool) {
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) =
            abi.decode(proof, (uint256[2], uint256[2][2], uint256[2]));
        uint256[10] memory sigs;
        for (uint256 i = 0; i < 10; i++) {
            sigs[i] = uint256(publicInputs[i]);
        }
        return BetAuthG16Base(base).verifyProof(pA, pB, pC, sigs);
    }

    /// @notice UUPS upgrade authorization. Owner-gated, instant (no timelock).
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
