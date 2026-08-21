import { agentRequestMessage, type AgentApiAction, type SignedAgentRequest } from "../lib/agents/api";

export interface MimirAgentSdkOptions {
  baseUrl: string;
  agentId: string;
  signMessage(message: string): Promise<`0x${string}`>;
  now?: () => number;
  nonce?: () => string;
}

export class MimirAgentClient {
  constructor(private readonly options: MimirAgentSdkOptions) {}

  async request<TBody, TResult>(action: AgentApiAction, body: TBody, idempotencyKey = crypto.randomUUID()): Promise<TResult> {
    const unsigned = {
      version: "v1" as const,
      agentId: this.options.agentId,
      action,
      idempotencyKey,
      nonce: this.options.nonce?.() ?? crypto.randomUUID(),
      signedAt: this.options.now?.() ?? Date.now(),
      body,
    };
    const request: SignedAgentRequest<TBody> = {
      ...unsigned,
      signature: await this.options.signMessage(agentRequestMessage(unsigned)),
    };
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/api/agents/v1/${action}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message ?? `Mimir Agent API ${response.status}`);
    return payload as TResult;
  }

  heartbeat = () => this.request("heartbeat", {});
  register = (body: unknown, key?: string) => this.request("register", body, key);
  proposeMarket = (body: unknown, key?: string) => this.request("proposeMarket", body, key);
  createMarket = (body: unknown, key?: string) => this.request("createMarket", body, key);
  dryRun = (body: unknown) => this.request("dryRun", body);
  publishReasoning = (body: unknown, key?: string) => this.request("publishReasoning", body, key);
  vote = (body: unknown, key?: string) => this.request("vote", body, key);
  stake = (body: unknown, key?: string) => this.request("stake", body, key);
  listPositions = () => this.request("listPositions", {});
  listEarnings = () => this.request("listEarnings", {});
  revoke = (body: { reason: string }, key?: string) => this.request("revoke", body, key);
}
