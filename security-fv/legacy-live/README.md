# legacy-live — previous revision of three circuits

Verbatim copies (`git show e66b43c:packages/circuits/groth16/<name>.circom`) of `bet_cancel`, `cancel_credit` and `partial_credit` as they were at commit `e66b43c`
(2026-06-06). They bind the bet via `nullifier_of_bet = Poseidon2(secret, nonce − 1)`; HEAD uses a private `bet_nonce < nonce`. The verification keys of the
**Polygon deployment correspond to this revision** (see the repository README), so the FV tooling checks them as `bet_cancel_live`, `cancel_credit_live`, `partial_credit_live`.

The other six circuits are source-identical between `e66b43c` and HEAD. Delete this directory once the deployed verifiers are re-keyed to HEAD.
