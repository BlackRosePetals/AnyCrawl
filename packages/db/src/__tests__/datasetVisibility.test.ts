import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Dataset retention is a VIEW, not a purge.
 *
 * A dataset's `retention_policy` hides inactive items past `item_days`, and
 * changes / run warnings past `change_days`, from every user-facing read — and
 * deletes nothing. These tests seed one dataset with rows on both sides of each
 * cutoff and call EVERY read path (items, run items, changes, run warnings,
 * exports, item counts), so a read that forgets the policy fails here instead of
 * leaking hidden rows. The final checks prove no row was ever removed and that
 * loosening the policy brings everything back.
 *
 * The db package resolves its dialect-specific `schemas` from ANYCRAWL_API_DB_TYPE
 * at import time, so SQLite is forced before importing it (as datasetRead.test.ts).
 */
process.env.ANYCRAWL_API_DB_TYPE = "sqlite";

let schema: any;
let getDatasetItems: any;
let listDatasetRunItems: any;
let listDatasetChanges: any;
let listRunWarnings: any;
let listDatasetExports: any;
let getDatasetExport: any;
let withVisibleItemCounts: any;
let datasetVisibilityCutoffs: any;
let updateDataset: any;

let sqlite: any;
let db: any;

function applyMigrations(files: string[]): void {
    for (const file of files) {
        const ddl = readFileSync(resolve(process.cwd(), file), "utf8");
        for (const raw of ddl.split("--> statement-breakpoint")) {
            const stmt = raw.trim();
            if (stmt.length > 0) sqlite.exec(stmt);
        }
    }
}

const DAY = 86_400_000;
const now = new Date();
const OLD = new Date(now.getTime() - 60 * DAY); // past a 30-day cutoff
const RECENT = new Date(now.getTime() - 1 * DAY); // inside it

const rawCount = (table: string, datasetColumn: string, id: string): number =>
    (sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${datasetColumn} = ?`).get(id) as any).c;

/**
 * One dataset, one run, and for every axis a row that must be hidden and a row
 * that must stay. Returns the ids the assertions need.
 */
async function seed(retentionPolicy: { item_days?: number; change_days?: number } | null) {
    const [dataset] = await db.insert(schema.datasets).values({
        name: `ds-${Math.random()}`,
        sourceType: "manual",
        schemaName: "s",
        schemaVersion: "1.0.0",
        retentionPolicy,
        itemCount: 3,
        activeItemCount: 1,
        createdAt: OLD,
        updatedAt: OLD,
    }).returning();

    const [run] = await db.insert(schema.datasetRuns).values({
        datasetId: dataset.uuid,
        producerType: "manual",
        producerId: `run-${Math.random()}`,
        scopeKey: "scope",
        status: "completed",
        createdAt: OLD,
        updatedAt: OLD,
    }).returning();

    const item = async (itemKey: string, isActive: boolean, lastSeenAt: Date) => {
        const [row] = await db.insert(schema.datasetItems).values({
            datasetId: dataset.uuid,
            itemKey,
            sourceType: "manual",
            document: { key: itemKey },
            documentHash: itemKey,
            firstSeenAt: OLD,
            lastSeenAt,
            isActive,
            createdAt: OLD,
            updatedAt: lastSeenAt,
        }).returning();
        return row;
    };
    // Active items are never hidden, however old they are.
    const activeOld = await item("active-old", true, OLD);
    const inactiveOld = await item("inactive-old", false, OLD);
    const inactiveRecent = await item("inactive-recent", false, RECENT);

    let sequence = 0;
    for (const it of [activeOld, inactiveOld, inactiveRecent]) {
        await db.insert(schema.datasetRunItems).values({
            datasetRunId: run.uuid,
            datasetItemId: it.uuid,
            itemKey: it.itemKey,
            sequence: sequence++,
            createdAt: OLD,
        });
    }

    const change = async (itemRow: any, createdAt: Date) => {
        const [row] = await db.insert(schema.datasetItemChanges).values({
            datasetId: dataset.uuid,
            datasetRunId: run.uuid,
            datasetItemId: itemRow.uuid,
            itemKey: itemRow.itemKey,
            scopeKey: "scope",
            changeType: createdAt === OLD ? "created" : "updated",
            createdAt,
        }).returning();
        return row;
    };
    const oldChange = await change(activeOld, OLD);
    const recentChange = await change(activeOld, RECENT);

    const warning = async (code: string, createdAt: Date) => {
        const [row] = await db.insert(schema.runWarnings).values({
            datasetRunId: run.uuid,
            scope: "item",
            code,
            createdAt,
        }).returning();
        return row;
    };
    const oldWarning = await warning("old", OLD);
    const recentWarning = await warning("recent", RECENT);

    const exp = async (createdAt: Date) => {
        const [row] = await db.insert(schema.datasetExports).values({
            datasetId: dataset.uuid,
            format: "jsonl",
            status: "completed",
            fileKey: `dataset-exports/${dataset.uuid}/${createdAt.getTime()}.jsonl`,
            createdAt,
            updatedAt: createdAt,
        }).returning();
        return row;
    };
    const oldExport = await exp(OLD);
    const recentExport = await exp(RECENT);

    return {
        dataset, run,
        activeOld, inactiveOld, inactiveRecent,
        oldChange, recentChange,
        oldWarning, recentWarning,
        oldExport, recentExport,
    };
}

const keys = (rows: any[], field = "itemKey") => rows.map((r) => r[field]).sort();

beforeAll(async () => {
    process.env.ANYCRAWL_API_DB_TYPE = "sqlite";
    schema = await import("../db/schemas/SQLite.js");
    const dbPkg: any = await import("../index.js");
    ({
        getDatasetItems,
        listDatasetRunItems,
        listDatasetChanges,
        listRunWarnings,
        listDatasetExports,
        getDatasetExport,
        withVisibleItemCounts,
        datasetVisibilityCutoffs,
        updateDataset,
    } = dbPkg);

    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = OFF");
    applyMigrations([
        "drizzle/SQLite/0012_dataset_core_tables.sql",
        "drizzle/SQLite/0017_dataset_jsonb_query.sql",
        "drizzle/SQLite/0018_modern_mandrill.sql",
    ]);
    db = drizzle(sqlite, { schema });
});

afterAll(() => {
    sqlite?.close();
});

describe("datasetVisibilityCutoffs", () => {
    it("derives a cutoff per axis", () => {
        const c = datasetVisibilityCutoffs({ item_days: 30, change_days: 7 }, now);
        expect(c.itemCutoff.getTime()).toBe(now.getTime() - 30 * DAY);
        expect(c.changeCutoff.getTime()).toBe(now.getTime() - 7 * DAY);
    });

    it.each([null, undefined, {}, { item_days: 0 }, { item_days: -5 }, { item_days: "30" }, { item_days: NaN }])
        ("hides nothing for policy %p", (policy) => {
            const c = datasetVisibilityCutoffs(policy as any, now);
            expect(c.itemCutoff).toBeNull();
        });
});

describe("a retention policy hides rows from every read path", () => {
    let f: Awaited<ReturnType<typeof seed>>;
    beforeAll(async () => {
        f = await seed({ item_days: 30, change_days: 30 });
    });

    it("items: hides only inactive items last seen before the cutoff", async () => {
        const page = await getDatasetItems(db, { datasetId: f.dataset.uuid, limit: 50 });
        expect(keys(page.items)).toEqual(["active-old", "inactive-recent"]);
    });

    it("items: an active item stays visible however old", async () => {
        const page = await getDatasetItems(db, { datasetId: f.dataset.uuid, limit: 50 });
        expect(page.items.map((i: any) => i.uuid)).toContain(f.activeOld.uuid);
    });

    it("run items: hides members whose item is hidden", async () => {
        const page = await listDatasetRunItems(db, f.run.uuid, { limit: 50 });
        expect(keys(page.items)).toEqual(["active-old", "inactive-recent"]);
    });

    it("changes: hides changes created before the change cutoff", async () => {
        const page = await listDatasetChanges(db, f.dataset.uuid, { limit: 50 });
        expect(page.items.map((c: any) => c.uuid)).toEqual([f.recentChange.uuid]);
    });

    it("run warnings: hides warnings created before the change cutoff", async () => {
        const page = await listRunWarnings(db, f.run.uuid, { limit: 50 });
        expect(page.items.map((w: any) => w.uuid)).toEqual([f.recentWarning.uuid]);
    });

    it("exports: an export older than the item cutoff is neither listed nor fetchable", async () => {
        const page = await listDatasetExports(db, f.dataset.uuid, { limit: 50 });
        expect(page.items.map((e: any) => e.uuid)).toEqual([f.recentExport.uuid]);
        // Single-get is what mints the download URL, so it must 404 too.
        expect(await getDatasetExport(db, f.dataset.uuid, f.oldExport.uuid)).toBeNull();
        expect(await getDatasetExport(db, f.dataset.uuid, f.recentExport.uuid)).not.toBeNull();
    });

    it("item count: reports what the item list returns, not the stored counter", async () => {
        const [visible] = await withVisibleItemCounts(db, [f.dataset]);
        expect(f.dataset.itemCount).toBe(3); // stored counter includes the hidden item
        expect(visible.itemCount).toBe(2);
        expect(visible.activeItemCount).toBe(1); // active items are never hidden
    });

    it("deletes nothing — every hidden row is still in the database", () => {
        expect(rawCount("dataset_items", "dataset_id", f.dataset.uuid)).toBe(3);
        expect(rawCount("dataset_run_items", "dataset_run_id", f.run.uuid)).toBe(3);
        expect(rawCount("dataset_item_changes", "dataset_id", f.dataset.uuid)).toBe(2);
        expect(rawCount("run_warnings", "dataset_run_id", f.run.uuid)).toBe(2);
        expect(rawCount("dataset_exports", "dataset_id", f.dataset.uuid)).toBe(2);
    });
});

describe("the view is reversible", () => {
    it("clearing the policy shows every hidden row again", async () => {
        const f = await seed({ item_days: 30, change_days: 30 });
        expect((await getDatasetItems(db, { datasetId: f.dataset.uuid, limit: 50 })).items).toHaveLength(2);

        const updated = await updateDataset(db, f.dataset.uuid, { retentionPolicy: null });

        expect(keys((await getDatasetItems(db, { datasetId: f.dataset.uuid, limit: 50 })).items))
            .toEqual(["active-old", "inactive-old", "inactive-recent"]);
        expect((await listDatasetRunItems(db, f.run.uuid, { limit: 50 })).items).toHaveLength(3);
        expect((await listDatasetChanges(db, f.dataset.uuid, { limit: 50 })).items).toHaveLength(2);
        expect((await listRunWarnings(db, f.run.uuid, { limit: 50 })).items).toHaveLength(2);
        expect((await listDatasetExports(db, f.dataset.uuid, { limit: 50 })).items).toHaveLength(2);
        const [visible] = await withVisibleItemCounts(db, [updated]);
        expect(visible.itemCount).toBe(3);
    });
});

describe("a dataset without a policy is untouched", () => {
    it("shows everything and keeps the stored counter", async () => {
        const f = await seed(null);
        expect((await getDatasetItems(db, { datasetId: f.dataset.uuid, limit: 50 })).items).toHaveLength(3);
        expect((await listDatasetRunItems(db, f.run.uuid, { limit: 50 })).items).toHaveLength(3);
        expect((await listDatasetChanges(db, f.dataset.uuid, { limit: 50 })).items).toHaveLength(2);
        expect((await listRunWarnings(db, f.run.uuid, { limit: 50 })).items).toHaveLength(2);
        expect((await listDatasetExports(db, f.dataset.uuid, { limit: 50 })).items).toHaveLength(2);
        const [visible] = await withVisibleItemCounts(db, [f.dataset]);
        expect(visible).toBe(f.dataset); // same object: no recount query
    });

    it("hides items only on the axis that is set", async () => {
        const f = await seed({ change_days: 30 });
        expect((await getDatasetItems(db, { datasetId: f.dataset.uuid, limit: 50 })).items).toHaveLength(3);
        expect((await listDatasetChanges(db, f.dataset.uuid, { limit: 50 })).items).toHaveLength(1);
        // Exports follow the item axis, which is unset here.
        expect((await listDatasetExports(db, f.dataset.uuid, { limit: 50 })).items).toHaveLength(2);
    });
});
