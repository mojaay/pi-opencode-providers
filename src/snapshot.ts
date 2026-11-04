// Persistent catalog snapshot for the Go monitor.
//
// The file holds the last successful model list and the diff against the run
// before it. A missing or corrupt file is treated as a first run, never as an
// error: the monitor must keep working after a manual delete.

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { diffCatalogs, diffFingerprint, type CatalogDiff, type MonitorSnapshot } from "./monitor.ts";

export const SNAPSHOT_PATH = join(homedir(), ".pi", "agent", "pi-opencode", "opencode-go-models.json");

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function snapshotFrom(value: unknown): MonitorSnapshot | undefined {
	const body = record(value);
	const models = strings(body.models);
	if (models.length === 0) return undefined;
	const diff = record(body.diff);
	return {
		models,
		deprecated: strings(body.deprecated),
		diff: {
			added: strings(diff.added),
			removed: strings(diff.removed),
			deprecated: strings(diff.deprecated),
		},
		notified: typeof body.notified === "string" ? body.notified : "",
		updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : "",
	};
}

export async function readSnapshot(path: string = SNAPSHOT_PATH): Promise<MonitorSnapshot | undefined> {
	try {
		return snapshotFrom(JSON.parse(await readFile(path, "utf8")));
	} catch {
		return undefined;
	}
}

export async function writeSnapshot(snapshot: MonitorSnapshot, path: string = SNAPSHOT_PATH): Promise<void> {
	const temporary = `${path}.tmp`;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
	await rename(temporary, path);
}

export interface SnapshotUpdate {
	snapshot: MonitorSnapshot;
	diff: CatalogDiff;
	/** True when this diff has not been reported before. */
	notify: boolean;
}

/**
 * Fold a fresh catalog into the previous snapshot. Without a previous snapshot
 * the run only records a baseline: the diff stays empty and nothing is reported.
 */
export function updateSnapshot(
	previous: MonitorSnapshot | undefined,
	models: string[],
	deprecated: string[],
	now: Date = new Date(),
): SnapshotUpdate {
	const next = { models: [...models].sort(), deprecated: [...deprecated].sort() };
	if (!previous) {
		const empty: CatalogDiff = { added: [], removed: [], deprecated: [] };
		return {
			snapshot: { ...next, diff: empty, notified: "", updatedAt: now.toISOString() },
			diff: empty,
			notify: false,
		};
	}
	const diff = diffCatalogs(previous, next);
	const fingerprint = diffFingerprint(diff);
	return {
		snapshot: {
			...next,
			diff,
			notified: fingerprint || previous.notified,
			updatedAt: now.toISOString(),
		},
		diff,
		notify: fingerprint !== "" && fingerprint !== previous.notified,
	};
}
