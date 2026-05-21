import type { CircuitId } from "../interfaces";
export declare function ensureDir(dir: string): void;
export declare function sha256File(filePath: string): string;
export declare function runOrThrow(bin: string, args: string[], cwd?: string): void;
export declare function manifestPath(): string;
export declare function loadManifest(): Record<string, unknown>;
export declare function saveManifest(manifest: Record<string, unknown>): void;
export declare function assertSnarkjsInstalled(): void;
export declare function localSnarkjsBinary(): string;
export declare function setupDirectories(): void;
export declare function circuitMetadata(circuitId: CircuitId): Record<string, string>;
//# sourceMappingURL=shared.d.ts.map