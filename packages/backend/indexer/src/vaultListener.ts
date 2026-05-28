import { ethers } from "ethers";
import pino from "pino";
import { setResolvedAt } from "./database";

const logger = pino({ name: "vault-listener" });

const VAULT_ABI = [
  "event MarketResolved(bytes32 indexed market_id, uint64 payout_per_share, uint64 resolvedAt)",
];

export function startVaultListener(
  provider: ethers.JsonRpcProvider,
  vaultAddress: string
): void {
  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);

  vault.on(
    "MarketResolved",
    (market_id: string, _payout: bigint, resolvedAt: bigint) => {
      const ts = Number(resolvedAt) || Math.floor(Date.now() / 1000);
      setResolvedAt(market_id, ts);
      logger.info({ market_id, resolvedAt: ts }, "MarketResolved recorded in indexer");
    }
  );

  logger.info({ vault: vaultAddress }, "Listening for Vault MarketResolved events");
}
