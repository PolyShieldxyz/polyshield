use dep::std::hash::poseidon::bn254;

/// Verifies a Merkle inclusion proof for a 32-level binary Poseidon Merkle tree.
///
/// Returns the computed root. The caller asserts the return equals merkle_root.
/// indices[i] = 0: current is left child. indices[i] = 1: current is right child.
pub fn merkle_verify(
    leaf: Field,
    path: [Field; 32],
    indices: [u1; 32],
) -> Field {
    let mut current = leaf;
    for i in 0..32 {
        if indices[i] == 0 {
            current = bn254::hash_2([current, path[i]]);
        } else {
            current = bn254::hash_2([path[i], current]);
        }
    }
    current
}
