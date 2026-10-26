/** Genuine owning PostgreSQL/default factories. No REST, role, policy or cloud acceptance is inferred. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPlatformDb, platformDb, resetPlatformDbForTests } from "@/lib/controlplane/db";
import { platformBroker, isDefaultPlatformBrokerFor, resetPlatformBrokerForTests, setPlatformBrokerForTests, registerPlatformBrokerStore, registerPlatformBrokerPorts, registerDefaultPlatformComposition, createBroker } from "@/lib/capabilities/platform";
import { PlatformBrokerStore } from "@/lib/capabilities/platform-store";
import { platformScopeResolver } from "@/lib/platform/scopes";
import { PG_URL, makeHarness, closeSharedPgliteAfterAll } from "./support";
import { vi } from "vitest";
if(process.env.ZENITH_TEST_PLAN_PRODUCT_AUTHORITY_REQUIRED==="1"&&!PG_URL)throw new Error("Default broker origin requires owned PostgreSQL.");
closeSharedPgliteAfterAll();
beforeEach(async()=>{await resetPlatformDbForTests();resetPlatformBrokerForTests();vi.stubEnv("ZENITH_PLATFORM_BROKER_MEMORY","");vi.stubEnv("ZENITH_PLATFORM_DB","postgres");vi.stubEnv("ZENITH_PLATFORM_DB_URL",PG_URL??"");});
afterEach(async()=>{resetPlatformBrokerForTests();await resetPlatformDbForTests();vi.restoreAllMocks();vi.unstubAllEnvs();});
async function fixture(){const db=await platformDb(),broker=await platformBroker();return {db,broker};}
describe.skipIf(!PG_URL)("private default broker origin [postgres; factory provenance only]",()=>{
  it("actual default broker and genuine same-target owning pools retain private origin",async()=>{
    const f=await fixture(),peer=await openPlatformDb({kind:"postgres",url:PG_URL!,max:1});
    try{expect(isDefaultPlatformBrokerFor(f.broker,f.db)).toBe(true);expect(isDefaultPlatformBrokerFor(f.broker,peer)).toBe(true);}finally{await peer.close();}
    // The production composition (src/lib/platform/app.ts): the capabilities module builds the store and scope resolver itself.
    registerDefaultPlatformComposition(f.db);const composed=await platformBroker();
    expect(composed).not.toBe(f.broker);expect(isDefaultPlatformBrokerFor(composed,f.db)).toBe(true);
  });
  it.each(["copied broker","constructed broker","override broker","registered store","registered roles","registered scopes"] as const)("private default origin refuses %s",async change=>{
    const f=await fixture();let value:unknown=f.broker;
    if(change==="copied broker")value={...f.broker};if(change==="constructed broker")value=createBroker(f.broker.deps);
    if(change==="override broker")setPlatformBrokerForTests(f.broker);if(change==="registered store")registerPlatformBrokerStore(new PlatformBrokerStore(f.db));
    if(change==="registered roles")registerPlatformBrokerPorts({roles:f.broker.deps.roles});if(change==="registered scopes")registerPlatformBrokerPorts({scopes:platformScopeResolver(f.db)});
    expect(isDefaultPlatformBrokerFor(value,f.db)).toBe(false);
    if(change==="registered store"||change==="registered scopes")expect(isDefaultPlatformBrokerFor(await platformBroker(),f.db)).toBe(false);
  });
  it.each(["store method","broker method","role method","scope method","dependency getter","global getter"] as const)("method and descriptor provenance refuses %s without evaluating getters",async change=>{
    const f=await fixture();let getters=0;
    const value=change==="store method"?f.broker.deps.store:change==="role method"?f.broker.deps.roles:change==="scope method"?f.broker.deps.scopes:change==="dependency getter"?f.broker.deps:change==="global getter"?globalThis:f.broker;
    const key=change==="store method"?"getOperation":change==="role method"||change==="scope method"?"resolve":change==="dependency getter"?"roles":change==="global getter"?"__zenithPlatformBroker":"approve";
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    try{
      Object.defineProperty(value,key,change.endsWith("getter")?{get:()=>{getters++;throw new Error("Hostile getter must remain unevaluated.");},configurable:true}:{value:async()=>null,configurable:true,writable:true});
      expect(isDefaultPlatformBrokerFor(f.broker,f.db)).toBe(false);expect(getters).toBe(0);
    }finally{if(descriptor)Object.defineProperty(value,key,descriptor);else Reflect.deleteProperty(value,key);}
    expect(isDefaultPlatformBrokerFor(f.broker,f.db)).toBe(true);
  });
  it.each(["user","database","options"] as const)("current configuration startup override %s refuses genuine cached broker origin",async key=>{
    const f=await fixture(),url=new URL(PG_URL!);url.searchParams.set(key,"foreign-target");vi.stubEnv("ZENITH_PLATFORM_DB_URL",url.toString());
    expect(isDefaultPlatformBrokerFor(f.broker,f.db)).toBe(false);
  });
  it("closed genuine owner and copied SQL handle cannot establish default mutation origin",async()=>{
    const f=await fixture();expect(isDefaultPlatformBrokerFor(f.broker,{...f.db})).toBe(false);await f.db.close();expect(isDefaultPlatformBrokerFor(f.broker,f.db)).toBe(false);
  });
  it("public registered test broker remains usable while its mutation origin refuses",async()=>{
    const f=await fixture(),h=await makeHarness({kind:"memory"});setPlatformBrokerForTests(h.broker);
    expect(await platformBroker()).toBe(h.broker);expect(isDefaultPlatformBrokerFor(h.broker,f.db)).toBe(false);
  });
});
