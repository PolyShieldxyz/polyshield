// Builds the IVerifier adapter contract that wraps a snarkjs-generated Groth16
// base verifier. This MUST match the format the Vault expects (verified against
// the committed src/verifiers/*.sol): proof is abi.encode(uint256[2] pA,
// uint256[2][2] pB, uint256[2] pC) — 256 bytes — and publicInputs is bytes32[].
//
// The base verifier (snarkjs `Groth16Verifier`, renamed `<Name>G16Base`) exposes
// verifyProof(uint[2], uint[2][2], uint[2], uint[N]); the adapter decodes the
// packed proof and maps the bytes32[] public inputs into uint256[N].
export function buildAdapter(name: string, publicSignals: number): string {
  return `
/// @notice UUPS-upgradeable IVerifier adapter for the Groth16 ${name} circuit.
/// Proof encoding: abi.encode(uint256[2] pA, uint256[2][2] pB, uint256[2] pC) — 256 bytes.
/// Deployed behind an ERC1967Proxy; initialize(owner) deploys the ${name}G16Base.
/// VK re-key: deploy a new ${name}G16Base and call setBase(); adapter-logic change:
/// upgradeToAndCall to a new implementation.
contract ${name}Verifier is Initializable, UUPSUpgradeable, OwnableUpgradeable, IVerifier {
    address public base; // ${name}G16Base, in proxy storage
    uint256[49] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) external initializer {
        __Ownable_init(owner_);
        base = address(new ${name}G16Base());
    }

    /// @notice Adopt a freshly deployed base (new VK) without a full proxy migration. Owner-only.
    function setBase(address newBase) external onlyOwner {
        base = newBase;
    }

    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool) {
        (uint256[2] memory pA, uint256[2][2] memory pB, uint256[2] memory pC) =
            abi.decode(proof, (uint256[2], uint256[2][2], uint256[2]));
        uint256[${publicSignals}] memory sigs;
        for (uint256 i = 0; i < ${publicSignals}; i++) {
            sigs[i] = uint256(publicInputs[i]);
        }
        return ${name}G16Base(base).verifyProof(pA, pB, pC, sigs);
    }

    /// @notice UUPS upgrade authorization. Owner-gated, instant (no timelock).
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
`;
}
