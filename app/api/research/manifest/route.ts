import { NextResponse } from "next/server";
import { RESEARCH_ADAPTERS } from "@/lib/research/adapters";
import { CATEGORY_POLICIES } from "@/lib/research/categories";

export const runtime = "nodejs";
export async function GET() {
  return NextResponse.json({ schemaVersion: 1, adapters: RESEARCH_ADAPTERS, categories: CATEGORY_POLICIES });
}
