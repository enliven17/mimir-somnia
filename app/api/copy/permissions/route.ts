import { copyPolicyHash, validateCopyPermission, worstCaseCopySpend, type CopyPermission } from "@/lib/copy-trading";
import { getCopyPermission, listCopyExecutions, saveCopyPermission } from "@/lib/db";
import { verifyAgentSignature } from "@/lib/agents/signature";

export const dynamic = "force-dynamic";

function policyMessage(permission: Omit<CopyPermission, "signedPolicyHash">): string {
  const hash = copyPolicyHash(permission);
  return `Mimir copy permission\npermission: ${permission.permissionId}\nowner: ${permission.ownerWallet.toLowerCase()}\npolicyHash: ${hash}`;
}

export async function POST(req: Request): Promise<Response> {
  type JsonPermission = Omit<CopyPermission, "signedPolicyHash" | "spendPermission"> & {
    spendPermission: Omit<CopyPermission["spendPermission"], "allowanceAtomic"> & { allowanceAtomic: string | bigint };
  };
  let body: { permission?: JsonPermission; signature?: `0x${string}` };
  try { body = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  if (!body.permission || !body.signature) return Response.json({ error: "permission and signature required" }, { status: 400 });
  let permission: Omit<CopyPermission, "signedPolicyHash">;
  try {
    permission = { ...body.permission, spendPermission: {
      ...body.permission.spendPermission,
      allowanceAtomic: BigInt(body.permission.spendPermission.allowanceAtomic),
    } };
  } catch { return Response.json({ error: "invalid_spend_permission" }, { status: 400 }); }
  const validationError = validateCopyPermission(permission);
  if (validationError) return Response.json({ error: validationError }, { status: 400 });
  const signedPolicyHash = copyPolicyHash(permission);
  const valid = await verifyAgentSignature({ address: permission.ownerWallet, message: policyMessage(permission), signature: body.signature });
  if (!valid) return Response.json({ error: "owner signature rejected" }, { status: 401 });
  const record: CopyPermission = { ...permission, signedPolicyHash };
  await saveCopyPermission(record);
  return Response.json({ permission: record, worstCase: worstCaseCopySpend(record) });
}

export async function DELETE(req: Request): Promise<Response> {
  let body: { permissionId?: string; signature?: `0x${string}` };
  try { body = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const permissionId = body.permissionId?.trim();
  if (!permissionId || !body.signature) return Response.json({ error: "permissionId and signature required" }, { status: 400 });
  const permission = await getCopyPermission(permissionId);
  if (!permission) return Response.json({ error: "permission not found" }, { status: 404 });
  const message = `Mimir revoke copy permission\npermission: ${permission.permissionId}\nowner: ${permission.ownerWallet.toLowerCase()}`;
  const valid = await verifyAgentSignature({ address: permission.ownerWallet, message, signature: body.signature });
  if (!valid) return Response.json({ error: "owner signature rejected" }, { status: 401 });
  const revoked: CopyPermission = { ...permission, status: "revoked" };
  await saveCopyPermission(revoked);
  return Response.json({ permissionId: revoked.permissionId, status: "revoked" });
}

export async function GET(req: Request): Promise<Response> {
  const permissionId = new URL(req.url).searchParams.get("permissionId")?.trim();
  if (!permissionId) return Response.json({ error: "permissionId required" }, { status: 400 });
  const executions = await listCopyExecutions(permissionId, 100);
  return Response.json({ permissionId, executions }, { headers: { "cache-control": "no-store" } });
}
