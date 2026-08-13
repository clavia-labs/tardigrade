import { a as Wake, c as Self, i as Spill, n as Placement, o as Writer, r as Sink, s as Router, v as EventLog } from "./src-BDBJZOcw.js";
import { Effect, Layer } from "effect";
//#region packages/runtime-memory/src/event-log.ts
const memoryEventLog = (options) => {
	const keyOf = options.keyOf;
	const rows = [];
	const keys = /* @__PURE__ */ new Set();
	let seq = 0;
	const put = (events) => {
		const landing = [];
		const batch = /* @__PURE__ */ new Set();
		for (const event of events) {
			const key = keyOf(event);
			if (key !== void 0 && (keys.has(key) || batch.has(key))) continue;
			if (key !== void 0) batch.add(key);
			landing.push({
				key,
				event
			});
		}
		for (const { key, event } of landing) {
			seq += 1;
			rows.push({
				seq,
				event
			});
			if (key !== void 0) keys.add(key);
		}
	};
	put(options.seed ?? []);
	return {
		append: (events) => Effect.sync(() => put(events)),
		read: Effect.sync(() => rows.map((row) => row.event)),
		readFrom: (from) => Effect.sync(() => rows.filter((row) => row.seq > from).map((row) => row.event)),
		head: Effect.sync(() => rows.at(-1)?.seq ?? 0)
	};
};
//#endregion
//#region packages/runtime-memory/src/runtime.ts
const MemoryRuntime = (options) => {
	const session = options.session ?? "memory";
	const log = memoryEventLog(options);
	const leases = /* @__PURE__ */ new Map();
	const leaseOf = (address) => {
		const held = leases.get(address);
		if (held !== void 0) return held;
		const fresh = Effect.unsafeMakeSemaphore(1);
		leases.set(address, fresh);
		return fresh;
	};
	let armed;
	const blobs = /* @__PURE__ */ new Map();
	let spilled = 0;
	const routed = (address, event) => Effect.suspend(() => options.route?.(address, event) ?? Effect.die(/* @__PURE__ */ new Error(`memory runtime: no route to "${address}" for "${event.type}"`)));
	return Layer.mergeAll(Layer.succeed(EventLog, log), Layer.succeed(Writer, { hold: (address, work) => leaseOf(address).withPermits(1)(work) }), Layer.succeed(Wake, {
		armIfSooner: (at) => Effect.sync(() => {
			if (armed === void 0 || at < armed) armed = at;
		}),
		owed: Effect.sync(() => armed === void 0 ? [] : [{
			session,
			at: armed
		}])
	}), Layer.succeed(Placement, { home: () => Effect.succeed(session) }), Layer.succeed(Spill, {
		put: (value) => Effect.sync(() => {
			spilled += 1;
			const ref = `spill:${spilled}`;
			blobs.set(ref, value);
			return ref;
		}),
		get: (ref) => Effect.suspend(() => {
			const value = blobs.get(ref);
			return value === void 0 ? Effect.die(/* @__PURE__ */ new Error(`memory runtime: no spilled value at "${ref}"`)) : Effect.succeed(value);
		})
	}), Layer.succeed(Sink, { write: () => Effect.void }), Layer.succeed(Router, {
		deliver: (address, event) => Effect.asVoid(routed(address, event)),
		call: routed
	}), Layer.succeed(Self, session));
};
//#endregion
export { MemoryRuntime };
