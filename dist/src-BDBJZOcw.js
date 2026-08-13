import { Clock, Context, Effect, Option } from "effect";
//#region packages/core/src/event-log.ts
var EventLog = class extends Context.Tag("flamecast/EventLog")() {};
const dedupKey = (event) => typeof event.key === "string" ? event.key : void 0;
//#endregion
//#region packages/core/src/machine.ts
const erase = (m) => m;
const machine = (definition) => {
	for (const [name, state] of Object.entries(definition.states)) if (state.decide !== void 0 && state.act !== void 0) throw new Error(`machine "${definition.id}" malformed: the state "${name}" defines both decide and act`);
	return definition;
};
const viewOf = (m, log) => m.view?.(log) ?? log;
const foldStep = (m, at, view, index) => {
	const event = view[index];
	if (event === void 0) return at;
	const rule = m.states[at.name]?.on?.[event.type];
	if (rule === void 0) return at;
	if (typeof rule === "string") return {
		name: rule,
		context: at.context
	};
	if (rule.when !== void 0 && !rule.when(view.slice(0, index + 1))) return at;
	return {
		name: rule.target,
		context: rule.assign === void 0 ? at.context : rule.assign(at.context, event)
	};
};
const fold = (m, view) => {
	let at = {
		name: m.initial,
		context: m.context
	};
	for (let index = 0; index < view.length; index++) at = foldStep(m, at, view, index);
	return at;
};
const foldOf = (m, log) => fold(m, viewOf(m, log));
const stateOf = (m, log) => foldOf(m, log).name;
const incarnationOf = (view) => {
	const head = view[0];
	if (head === void 0) return "";
	return String(head.id ?? head.runId ?? "");
};
const settle = (m) => Effect.gen(function* () {
	const store = yield* EventLog;
	let log = yield* store.read;
	let seq = yield* store.head;
	while (true) {
		const seen = viewOf(m, log);
		const { name, context } = fold(m, seen);
		const definition = m.states[name];
		const slot = definition?.decide !== void 0 ? "decide" : "act";
		let emitted;
		if (definition?.decide !== void 0) emitted = definition.decide(log, yield* Clock.currentTimeMillis, context);
		else if (definition?.act !== void 0) emitted = yield* definition.act(log, context);
		else return;
		if (emitted.length === 0) return yield* Effect.die(/* @__PURE__ */ new Error(`machine "${m.id}" wedged: the ${slot} of "${name}" emitted nothing`));
		yield* store.append(emitted);
		log = [...log, ...yield* store.readFrom(seq)];
		seq = yield* store.head;
		const seenAfter = viewOf(m, log);
		if (fold(m, seenAfter).name === name && incarnationOf(seenAfter) === incarnationOf(seen)) return yield* Effect.die(/* @__PURE__ */ new Error(`machine "${m.id}" wedged: the ${slot} of "${name}" did not transition`));
	}
});
const resting = (machines, log) => machines.every((m) => {
	const state = m.states[stateOf(m, log)];
	return state?.decide === void 0 && state?.act === void 0;
});
const settleAll = (machines) => Effect.gen(function* () {
	const store = yield* EventLog;
	while (true) {
		const before = yield* store.head;
		for (const m of machines) yield* settle(m);
		if ((yield* store.head) === before) return;
	}
});
//#endregion
//#region packages/core/src/actor.ts
var Self = class extends Context.Tag("flamecast/Self")() {};
const actor = (machines) => ({ machines });
const send = (a, event) => Effect.gen(function* () {
	yield* (yield* EventLog).append([event]);
	yield* settleAll(a.machines);
});
//#endregion
//#region packages/core/src/router.ts
var Router = class extends Context.Tag("flamecast/Router")() {};
//#endregion
//#region packages/core/src/ports.ts
var Writer = class extends Context.Tag("flamecast/Writer")() {};
var Wake = class extends Context.Tag("flamecast/Wake")() {};
var Placement = class extends Context.Tag("flamecast/Placement")() {};
var Spill = class extends Context.Tag("flamecast/Spill")() {};
var Sink = class extends Context.Tag("flamecast/Sink")() {};
//#endregion
//#region packages/core/src/conformance.ts
const PROBE_KEY = "flamecast/conformance/dedup-probe";
const PROBE = {
	type: "ConformanceProbe",
	key: PROBE_KEY
};
const NOW = 0;
const reasonOf = (error) => error instanceof Error ? error.message : String(error);
const rigged = (run) => {
	const clock = Date.now;
	const random = Math.random;
	Date.now = () => {
		throw new Error("read the clock");
	};
	Math.random = () => {
		throw new Error("read the random source");
	};
	try {
		return run();
	} finally {
		Date.now = clock;
		Math.random = random;
	}
};
const same = (a, b) => {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const left = a;
	const right = b;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => key in right && same(left[key], right[key]));
};
const trace = (m, log) => {
	const states = [];
	let at = foldOf(m, []);
	states.push(at);
	for (let index = 0; index < log.length; index++) {
		try {
			at = m.view === void 0 ? foldStep(m, at, log, index) : foldOf(m, log.slice(0, index + 1));
		} catch (error) {
			throw new Error(`the fold of state "${at.name}" threw on event "${log[index]?.type ?? ""}": ${reasonOf(error)}`);
		}
		states.push(at);
	}
	return states;
};
const targetOf = (transition) => typeof transition === "string" ? transition : transition.target;
const checkOf = (failures) => ({
	ok: failures.length === 0,
	failures
});
const conformance = (options) => Effect.gen(function* () {
	const keyOf = options.keyOf;
	const purity = /* @__PURE__ */ new Set();
	const idempotence = /* @__PURE__ */ new Set();
	const wedge = /* @__PURE__ */ new Set();
	const dedup = /* @__PURE__ */ new Set();
	for (const m of options.machines) {
		for (const [name, definition] of Object.entries(m.states)) {
			if (definition.decide === void 0 && definition.act === void 0) continue;
			if (!Object.values(definition.on ?? {}).some((t) => targetOf(t) !== name)) wedge.add(`machine "${m.id}": the active state "${name}" declares no transition that leaves it, so a settle can not stop`);
		}
		for (const [index, recorded] of options.logs.entries()) {
			let states;
			try {
				const first = rigged(() => trace(m, recorded));
				const second = rigged(() => trace(m, recorded));
				const drift = first.findIndex((state, i) => !same(state, second[i]));
				if (drift !== -1) purity.add(`machine "${m.id}": folding log ${index} twice gave "${first[drift]?.name}" then "${second[drift]?.name}" after ${drift} event(s)`);
				states = first;
			} catch (error) {
				purity.add(`machine "${m.id}" on log ${index}: ${reasonOf(error)}`);
				continue;
			}
			for (const [prefix, at] of states.entries()) {
				const definition = m.states[at.name];
				const decide = definition?.decide;
				if (decide === void 0) continue;
				const log = recorded.slice(0, prefix);
				let emitted;
				try {
					emitted = rigged(() => decide(log, NOW, at.context));
					if (!same(emitted, rigged(() => decide(log, NOW, at.context)))) {
						purity.add(`machine "${m.id}": the decide of "${at.name}" emitted two different results for one log`);
						continue;
					}
				} catch (error) {
					purity.add(`machine "${m.id}": the decide of "${at.name}" threw: ${reasonOf(error)}`);
					continue;
				}
				if (emitted.length === 0) wedge.add(`machine "${m.id}": the decide of "${at.name}" emitted nothing`);
				else if (!emitted.some((event) => definition?.on?.[event.type] !== void 0)) wedge.add(`machine "${m.id}": the decide of "${at.name}" emitted ${emitted.map((event) => `"${event.type}"`).join(", ")} and that state transitions on none of them`);
				if (prefix === recorded.length && emitted.length > 0) idempotence.add(`machine "${m.id}": a second settle of log ${index} appends ${emitted.length} event(s) from the decide of "${at.name}"`);
			}
			const end = states[states.length - 1];
			if (end !== void 0 && m.states[end.name]?.act !== void 0) idempotence.add(`machine "${m.id}": a second settle of log ${index} runs the act of "${end.name}" again`);
		}
	}
	for (const [index, log] of options.logs.entries()) {
		const seen = /* @__PURE__ */ new Map();
		for (const [position, event] of log.entries()) {
			const key = keyOf(event);
			if (key === void 0) continue;
			const prior = seen.get(key);
			if (prior === void 0) seen.set(key, position);
			else dedup.add(`log ${index}: the key "${key}" lands twice, at ${prior} and ${position}, so a redelivered "${event.type}" was not absorbed`);
		}
	}
	const store = yield* Effect.serviceOption(EventLog);
	if (Option.isSome(store) && keyOf(PROBE) !== void 0) {
		const log = store.value;
		const before = yield* log.head;
		yield* log.append([PROBE]);
		const once = yield* log.head;
		yield* log.append([PROBE]);
		const landed = (yield* log.readFrom(before)).filter((event) => event.type === PROBE.type);
		if (once <= before) dedup.add("the store appended no event for a keyed batch, so nothing landed");
		if ((yield* log.head) !== once) dedup.add(`the store appended a redelivered event twice for the key "${PROBE_KEY}"`);
		if (landed.length !== 1) dedup.add(`the store returned ${landed.length} copies of one redelivered event from its watermark`);
	}
	return {
		ok: purity.size === 0 && idempotence.size === 0 && wedge.size === 0 && dedup.size === 0,
		purity: checkOf([...purity]),
		idempotence: checkOf([...idempotence]),
		wedge: checkOf([...wedge]),
		dedup: checkOf([...dedup])
	};
});
//#endregion
export { stateOf as _, Wake as a, Self as c, erase as d, foldOf as f, settleAll as g, settle as h, Spill as i, actor as l, resting as m, Placement as n, Writer as o, machine as p, Sink as r, Router as s, conformance as t, send as u, EventLog as v, dedupKey as y };
