import { grantHandler } from "@/lib/runners/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = grantHandler("runner");
