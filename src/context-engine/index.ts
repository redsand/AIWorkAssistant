import { env } from "../config/env";
import { assembleContextPacket } from "./context-packet";
import type {
  ContextMode,
  ContextPacket,
  AssembleContextParams,
} from "./types";

export function shouldUseContextEngine(): boolean {
  return env.CONTEXT_MODE === "engine";
}

export async function assembleContext(
  params: AssembleContextParams,
): Promise<ContextPacket> {
  return assembleContextPacket(params);
}

export type { ContextMode, ContextPacket, AssembleContextParams };
export * from "./types";