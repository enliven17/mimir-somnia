import { consumeAgentNonce, getAgentApiResponse, getAgentRecord, insertAgentRequestAudit, saveAgentApiResponse, upsertAgentRecord } from "@/lib/db";
import type { AgentRecord } from "./registry";

declare global {
  // eslint-disable-next-line no-var
  var __mimirAgentRecords: Map<string, AgentRecord> | undefined;
  // eslint-disable-next-line no-var
  var __mimirAgentNonces: Set<string> | undefined;
  // eslint-disable-next-line no-var
  var __mimirAgentResponses: Map<string, { body: unknown; status: number }> | undefined;
}

const records = globalThis.__mimirAgentRecords ??= new Map<string, AgentRecord>();
const nonces = globalThis.__mimirAgentNonces ??= new Set<string>();
const responses = globalThis.__mimirAgentResponses ??= new Map();
const responseKey = (agentId: string, action: string, key: string) => `${agentId}:${action}:${key}`;

export async function saveAgent(agent: AgentRecord): Promise<void> {
  records.set(agent.agentId, agent);
  await upsertAgentRecord(agent).catch(() => undefined);
}

export async function loadAgent(agentId: string): Promise<AgentRecord | null> {
  try {
    const durable = await getAgentRecord(agentId);
    if (durable) records.set(agentId, durable);
    return durable ?? records.get(agentId) ?? null;
  } catch {
    return records.get(agentId) ?? null;
  }
}

export async function consumeNonce(agentId: string, nonce: string, at: number): Promise<boolean> {
  if (nonces.has(nonce)) return false;
  try {
    const consumed = await consumeAgentNonce(agentId, nonce, at);
    if (!consumed) return false;
  } catch {
    // Local development without Neon still gets process-lifetime replay defense.
  }
  nonces.add(nonce);
  return true;
}

export async function auditAgentRequest(row: Parameters<typeof insertAgentRequestAudit>[0]): Promise<void> {
  await insertAgentRequestAudit(row).catch(() => undefined);
}

export async function loadIdempotentResponse(agentId: string, action: string, key: string) {
  try {
    return await getAgentApiResponse(agentId, action, key) ?? responses.get(responseKey(agentId, action, key)) ?? null;
  } catch { return responses.get(responseKey(agentId, action, key)) ?? null; }
}

export async function saveIdempotentResponse(agentId: string, action: string, key: string, body: unknown, status = 200) {
  responses.set(responseKey(agentId, action, key), { body, status });
  await saveAgentApiResponse({ agentId, action, idempotencyKey: key, body, status, createdAt: Date.now() }).catch(() => undefined);
}
