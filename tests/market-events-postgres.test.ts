import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { MarketEventService, TaskService } from "../packages/core/dist/index.js";
import { PostgresStorage } from "../packages/storage/dist/index.js";
import { eventInput, taskInput } from "./market-event-fixtures.ts";

test("PostgreSQL market events: concurrent dedup, revision conflict, unique constraints, rollback and reconnect", { skip: !process.env.TEST_DATABASE_URL }, async t => {
	const url=process.env.TEST_DATABASE_URL!; const db=PostgresStorage.connect(url); t.after(()=>db.close());
	await db.initialize(); await db.initialize();
	const owner=crypto.randomUUID(); const service=new MarketEventService(db);
	const concurrent=await Promise.allSettled(Array.from({length:12},(_,i)=>service.create(owner,`key-${i}`,eventInput())));
	assert.ok(concurrent.some(result => result.status === "fulfilled"));
	for (const result of concurrent)
		if (result.status === "rejected") assert.match(String(result.reason), /event write in progress/);
	const versions = [];
	for (let i=0;i<12;i++) versions.push(await service.create(owner,`key-${i}`,eventInput()));
	assert.equal(new Set(versions.map(r=>r.version.id)).size,1); assert.equal(versions.filter(r=>r.status==="created").length,1);
	const eventId=versions[0]!.version.eventId;
	const revisions=await Promise.allSettled(["title-a","title-b"].map((title,i)=>service.revise(owner,eventId,`revision-${i}`,1,{...eventInput(),title},"更正标题")));
	assert.equal(revisions.filter(r=>r.status==="fulfilled").length,1); const rejection=revisions.find(r=>r.status==="rejected"); assert.ok(rejection?.status==="rejected"); assert.match(String(rejection.reason),/version conflict|write in progress/);
	const task=await new TaskService(db).create(owner+"-other","task",taskInput);
	await assert.rejects(service.create(owner,"foreign-task",{...eventInput(),occurrenceKey:"other",taskRefs:[{taskId:task.taskId,taskVersion:1,reason:"外部任务"}]}),/task not found/);
	await assert.rejects(db.transaction(async tx=>{ const head=await tx.marketEvents.get(eventId); assert.ok(head); await tx.marketEvents.put({...head,id:crypto.randomUUID()}); }), (e:unknown)=>typeof e==="object"&&e!==null&&"code" in e&&e.code==="23505");
	await assert.rejects(db.transaction(async tx=>{ const version=await tx.marketEventVersions.get(`${eventId}:1`); assert.ok(version); await tx.marketEventVersions.put({...version,id:crypto.randomUUID()}); }), (e:unknown)=>typeof e==="object"&&e!==null&&"code" in e&&e.code==="23505");
	await assert.rejects(db.transaction(async tx=>{ const head=await tx.marketEvents.get(eventId); assert.ok(head); await tx.marketEvents.put({...head,currentVersion:999}); throw new Error("forced rollback"); }),/forced rollback/);
	const reconnected=PostgresStorage.connect(url);t.after(()=>reconnected.close());await reconnected.initialize();
	const detail=await new MarketEventService(reconnected).detail(owner,eventId);assert.equal(detail?.current.version,2);assert.equal(detail?.versions.length,2);assert.deepEqual(detail?.versions[1],versions[0]!.version);
	assert.equal(await new MarketEventService(reconnected).detail(owner+"-other",eventId),null);
	const {Pool}=createRequire(new URL("../packages/storage/package.json",import.meta.url))("pg") as {Pool:new(options:{connectionString:string})=>{query(sql:string):Promise<{rows:Record<string,unknown>[]}>;end():Promise<void>}};
	const admin=new Pool({connectionString:url});t.after(()=>admin.end());const migration=await admin.query("SELECT version FROM adpulse_schema_migrations WHERE version=11");assert.equal(migration.rows.length,1);
});

test("PostgreSQL market events: migration 11 upgrades baseline 10 atomically without touching existing tasks", { skip: !process.env.TEST_DATABASE_URL }, async () => {
	const url=process.env.TEST_DATABASE_URL!;
	const { Pool }=createRequire(new URL("../packages/storage/package.json",import.meta.url))("pg") as {
		Pool: new(options:{connectionString:string;options?:string})=>ConstructorParameters<typeof PostgresStorage>[0];
	};
	const admin=new Pool({connectionString:url});const schema=`event_upgrade_${crypto.randomUUID().replaceAll("-","")}`;
	await admin.query(`CREATE SCHEMA ${schema}`);
	const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});const db=new PostgresStorage(pool);
	try {
		await db.initialize();const task=await new TaskService(db).create("owner","task",taskInput);
		// Reconstruct the exact pre-feature baseline within this disposable schema.
		for (const name of ["marketEvents","marketEventVersions","marketEventAliases","marketEventOperations"])
			await pool.query(`DROP TABLE adpulse_${name}`);
		await pool.query("DELETE FROM adpulse_schema_migrations WHERE version=11");
		await pool.query("CREATE TABLE adpulse_market_event_logical (id text)");
		await assert.rejects(db.initialize());
		const failed=await pool.query("SELECT to_regclass('adpulse_marketEvents') AS table_name");assert.equal(failed.rows[0].table_name,null);
		const migrations=await pool.query("SELECT version FROM adpulse_schema_migrations WHERE version=11");assert.equal(migrations.rows.length,0);
		assert.equal((await new TaskService(db).get("owner",task.taskId))?.product,task.product);
		await pool.query("DROP TABLE adpulse_market_event_logical");await db.initialize();await db.initialize();
		assert.deepEqual(await new TaskService(db).get("owner",task.taskId),task);
		const result=await new MarketEventService(db).create("owner","event",eventInput());assert.equal(result.status,"created");
	} finally {
		await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
	}
});
