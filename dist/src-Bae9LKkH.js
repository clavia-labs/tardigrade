import { c as Self, d as erase, g as settleAll, l as actor, o as Writer, p as machine, s as Router, u as send, v as EventLog, y as dedupKey } from "./src-BDBJZOcw.js";
import { Cause, Clock, Context, Effect, Exit, Layer, Option } from "effect";
//#region packages/harness/src/infer.ts
const selectedInference = (selection, log) => typeof selection === "function" ? selection(log) : selection;
const customInference = (react, options = {}) => {
	const model = options.model ?? "custom";
	return {
		id: options.id ?? `custom:${model}`,
		state: () => ({
			provider: options.id ?? "custom",
			model,
			contextWindow: options.contextWindow ?? 128e3
		}),
		react: (request, key) => Effect.promise(() => react(request, key))
	};
};
var Infer = class extends Context.Tag("flamecast/Infer")() {};
const inferWith = (react, options = {}) => Layer.succeed(Infer, customInference(react, options));
const usageOf$1 = (value) => {
	const carried = value;
	return {
		promptTokens: typeof carried?.promptTokens === "number" ? carried.promptTokens : 0,
		completionTokens: typeof carried?.completionTokens === "number" ? carried.completionTokens : 0,
		costUsd: typeof carried?.costUsd === "number" ? carried.costUsd : 0
	};
};
//#endregion
//#region packages/harness/src/sha256.ts
const K = new Uint32Array([
	1116352408,
	1899447441,
	3049323471,
	3921009573,
	961987163,
	1508970993,
	2453635748,
	2870763221,
	3624381080,
	310598401,
	607225278,
	1426881987,
	1925078388,
	2162078206,
	2614888103,
	3248222580,
	3835390401,
	4022224774,
	264347078,
	604807628,
	770255983,
	1249150122,
	1555081692,
	1996064986,
	2554220882,
	2821834349,
	2952996808,
	3210313671,
	3336571891,
	3584528711,
	113926993,
	338241895,
	666307205,
	773529912,
	1294757372,
	1396182291,
	1695183700,
	1986661051,
	2177026350,
	2456956037,
	2730485921,
	2820302411,
	3259730800,
	3345764771,
	3516065817,
	3600352804,
	4094571909,
	275423344,
	430227734,
	506948616,
	659060556,
	883997877,
	958139571,
	1322822218,
	1537002063,
	1747873779,
	1955562222,
	2024104815,
	2227730452,
	2361852424,
	2428436474,
	2756734187,
	3204031479,
	3329325298
]);
const rotr = (word, bits) => word >>> bits | word << 32 - bits;
const sha256 = (input) => {
	const bytes = new TextEncoder().encode(input);
	const padded = new Uint8Array((bytes.length + 8 >> 6) + 1 << 6);
	padded.set(bytes);
	padded[bytes.length] = 128;
	const block = new DataView(padded.buffer);
	block.setUint32(padded.length - 8, Math.floor(bytes.length / 536870912), false);
	block.setUint32(padded.length - 4, bytes.length << 3, false);
	const h = new Uint32Array([
		1779033703,
		3144134277,
		1013904242,
		2773480762,
		1359893119,
		2600822924,
		528734635,
		1541459225
	]);
	const w = /* @__PURE__ */ new Uint32Array(64);
	for (let at = 0; at < padded.length; at += 64) {
		for (let i = 0; i < 16; i++) w[i] = block.getUint32(at + i * 4, false);
		for (let i = 16; i < 64; i++) {
			const x = w[i - 15] ?? 0;
			const y = w[i - 2] ?? 0;
			const s0 = rotr(x, 7) ^ rotr(x, 18) ^ x >>> 3;
			const s1 = rotr(y, 17) ^ rotr(y, 19) ^ y >>> 10;
			w[i] = (w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1 >>> 0;
		}
		let a = h[0] ?? 0;
		let b = h[1] ?? 0;
		let c = h[2] ?? 0;
		let d = h[3] ?? 0;
		let e = h[4] ?? 0;
		let f = h[5] ?? 0;
		let g = h[6] ?? 0;
		let acc = h[7] ?? 0;
		for (let i = 0; i < 64; i++) {
			const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const choose = e & f ^ ~e & g;
			const t1 = acc + s1 + choose + (K[i] ?? 0) + (w[i] ?? 0) >>> 0;
			const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + (a & b ^ a & c ^ b & c) >>> 0;
			acc = g;
			g = f;
			f = e;
			e = d + t1 >>> 0;
			d = c;
			c = b;
			b = a;
			a = t1 + t2 >>> 0;
		}
		h[0] = (h[0] ?? 0) + a >>> 0;
		h[1] = (h[1] ?? 0) + b >>> 0;
		h[2] = (h[2] ?? 0) + c >>> 0;
		h[3] = (h[3] ?? 0) + d >>> 0;
		h[4] = (h[4] ?? 0) + e >>> 0;
		h[5] = (h[5] ?? 0) + f >>> 0;
		h[6] = (h[6] ?? 0) + g >>> 0;
		h[7] = (h[7] ?? 0) + acc >>> 0;
	}
	let out = "";
	for (const word of h) out += word.toString(16).padStart(8, "0");
	return out;
};
//#endregion
//#region packages/harness/src/program.ts
const WITHDRAW_ALL = "*";
const canonical = (value) => {
	if (value === null) return "null";
	if (typeof value === "function") return JSON.stringify("[function]");
	if (typeof value === "symbol") return JSON.stringify(String(value));
	if (typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const record = value;
	return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
};
const programId = (modules) => `sha256:${sha256(canonical(modules))}`;
const readSignal = (program, signal, log) => {
	const found = program.announcements.find((one) => one.signal.id === signal.id);
	if (found === void 0) throw new Error(`no module announces signal "${signal.id}"`);
	return found.read(log);
};
const canonicalValue = canonical;
//#endregion
//#region packages/harness/src/signal.ts
const signal = (id) => ({ id });
const announce = (signal, read) => ({
	signal,
	read
});
//#endregion
//#region packages/harness/src/boundary.ts
const stampOf$1 = (event) => event.turn === void 0 ? void 0 : String(event.turn);
const boundaryOf = (log, turn) => {
	const terminal = log.find((event) => (event.type === "TurnCompleted" || event.type === "TurnFailed") && stampOf$1(event) === turn);
	if (terminal !== void 0) return terminal.type === "TurnCompleted" ? {
		kind: "completed",
		output: String(terminal.output ?? "")
	} : {
		kind: "failed",
		error: String(terminal.error ?? "")
	};
	let pending;
	for (const event of log) {
		if (stampOf$1(event) !== turn) continue;
		if (event.type === "BudgetRequested") pending = event;
		else if (event.type === "BudgetGranted" || event.type === "BudgetDenied") pending = void 0;
	}
	if (pending === void 0) return void 0;
	return {
		kind: "parked",
		callId: String(pending.callId ?? ""),
		reason: String(pending.reason ?? ""),
		amount: Number(pending.amount ?? 0)
	};
};
//#endregion
//#region packages/harness/src/keys.ts
const keyOf = (event) => {
	const field = (name) => {
		const value = event[name];
		return value === void 0 || value === null ? void 0 : String(value);
	};
	const inTurn = (prefix, id) => id === void 0 ? void 0 : `${prefix}:${field("turn") ?? ""}/${id}`;
	switch (event.type) {
		case "MessageReceived": return field("id") === void 0 ? void 0 : `msg:${field("id")}`;
		case "RunFired": return field("runId") === void 0 ? void 0 : `rf:${field("runId")}`;
		case "RunReported": return field("run") === void 0 ? void 0 : `rr:${field("run")}`;
		case "RewardGranted": return field("run") === void 0 ? void 0 : `rw:${field("run")}/${field("regime") ?? ""}`;
		case "ToolReturned": return inTurn("tr", field("callId"));
		case "PackageReturned": return inTurn("pr", field("callId"));
		case "CodeDispatched": return inTurn("cd", field("execId"));
		case "CodeSettled": return inTurn("cs", field("execId"));
		default: return dedupKey(event);
	}
};
//#endregion
//#region packages/harness/src/context.ts
const estimateTokens = (events) => Math.ceil(events.reduce((total, event) => total + JSON.stringify(event).length, 0) / 4);
const checkpointOf = (log) => {
	let upTo = 0;
	let summary = "";
	for (const event of log) {
		if (event.type !== "CompactionCompleted") continue;
		upTo = Number(event.upTo ?? 0);
		summary = String(event.summary ?? "");
	}
	return {
		upTo,
		summary
	};
};
const suffixOf = (log) => log.slice(checkpointOf(log).upTo);
const keepUpTo = (log, keepTokens) => {
	let tokens = 0;
	for (let index = log.length - 1; index >= 0; index--) {
		const event = log[index];
		if (event === void 0) continue;
		tokens += estimateTokens([event]);
		if (tokens > keepTokens) return Math.min(index + 1, Math.max(log.length - 1, 0));
	}
	return 0;
};
//#endregion
//#region packages/harness/src/turns.ts
const idOf = (event) => String(event.id ?? "");
const stampOf = (event) => event.turn === void 0 ? void 0 : String(event.turn);
const stamped = (log, id) => log.filter((event) => stampOf(event) === id);
const hasStamped = (log, id, types) => log.some((event) => types.includes(event.type) && stampOf(event) === id);
const heads = (log) => log.filter((event) => event.type === "MessageReceived");
const TERMINALS = ["TurnCompleted", "TurnFailed"];
const turnHead = (log) => heads(log).find((head) => !hasStamped(log, idOf(head), TERMINALS));
const turnOf = (log) => {
	const head = turnHead(log);
	return head === void 0 ? "" : idOf(head);
};
const turnView = (log) => {
	const head = turnHead(log);
	return head === void 0 ? [] : [head, ...stamped(log, idOf(head))];
};
const replyView = (log) => {
	const head = heads(log).find((candidate) => hasStamped(log, idOf(candidate), TERMINALS) && !hasStamped(log, idOf(candidate), ["ReplyDelivered"]));
	return head === void 0 ? [] : [head, ...stamped(log, idOf(head))];
};
const servedLog = (log) => {
	const current = turnHead(log);
	const emitted = /* @__PURE__ */ new Set();
	const byId = new Map(heads(log).map((head) => [idOf(head), head]));
	const out = [];
	for (const event of log) {
		if (event.type === "MessageReceived") continue;
		const stamp = stampOf(event);
		if (stamp !== void 0 && !emitted.has(stamp)) {
			const head = byId.get(stamp);
			if (head !== void 0) out.push(head);
			emitted.add(stamp);
		}
		out.push(event);
	}
	if (current !== void 0 && !emitted.has(idOf(current))) out.push(current);
	return out;
};
const usageIn = (log, turn) => log.filter((event) => event.type === "ModelReturned" && stampOf(event) === turn).map((event) => usageOf$1(event.usage)).reduce((total, one) => ({
	promptTokens: total.promptTokens + one.promptTokens,
	completionTokens: total.completionTokens + one.completionTokens,
	costUsd: total.costUsd + one.costUsd
}), {
	promptTokens: 0,
	completionTokens: 0,
	costUsd: 0
});
const quoted = (value) => `"${String(value ?? "")}"`;
const usageLine = (value) => {
	const usage = usageOf$1(value);
	return `${usage.promptTokens} in / ${usage.completionTokens} out / $${usage.costUsd.toFixed(4)}`;
};
const TYPE_WIDTH = 18;
const WHO_WIDTH = 6;
const CALL_WIDTH = 7;
const widthOf = (values, minimum) => Math.max(minimum, ...values.map((value) => value === "" ? 0 : value.length + 3));
const detailOf = (event, callWidth) => {
	const call = (rest) => `${String(event.callId ?? "").padEnd(callWidth)}${rest}`;
	switch (event.type) {
		case "MessageReceived": return `${quoted(event.text)}   program=${String(event.program ?? "")}`;
		case "ModelCalled": return call("");
		case "ModelReturned": return call(usageLine(event.usage));
		case "TextReturned": return quoted(event.text);
		case "ToolCalled": return call(`${String(event.name ?? "")} ${JSON.stringify(event.arguments ?? {})}`);
		case "ToolReturned": return call(event.error === void 0 ? JSON.stringify(event.result ?? null) : `error: ${String(event.error)}`);
		case "TurnCompleted": return quoted(event.output);
		case "TurnFailed": return quoted(event.error);
		case "ReplyDelivered": return event.to === void 0 ? "" : `to=${String(event.to)}`;
		case "BudgetExhausted": return `budget=${String(event.budget ?? "")} used=${String(event.used ?? "")}`;
		case "BudgetRequested": return call(`amount=${String(event.amount ?? "")} ${quoted(event.reason)}`);
		case "BudgetGranted": return `amount=${String(event.amount ?? "")}`;
		case "BudgetDenied": return event.reason === void 0 ? "" : quoted(event.reason);
		case "AnswerRejected": return call(quoted(event.error));
		case "CompactionCompleted": return `upTo=${String(event.upTo ?? "")} provider=${String(event.provider ?? "")} ${quoted(event.summary)}`;
		default: {
			const { type: _type, turn: _turn, at: _at, ...rest } = event;
			return Object.keys(rest).length === 0 ? "" : JSON.stringify(rest);
		}
	}
};
const whoOf = (event) => event.type === "MessageReceived" ? idOf(event) : stampOf(event) ?? "";
const transcript = (log) => {
	const typeWidth = widthOf(log.map((event) => event.type), TYPE_WIDTH);
	const whoWidth = widthOf(log.map(whoOf), WHO_WIDTH);
	const callWidth = widthOf(log.map((event) => String(event.callId ?? "")), CALL_WIDTH);
	return log.map((event, index) => {
		return `${String(index + 1).padStart(2)}  ${event.type.padEnd(typeWidth)}${whoOf(event).padEnd(whoWidth)}${detailOf(event, callWidth)}`.trimEnd();
	}).join("\n");
};
//#endregion
//#region packages/harness/src/render.ts
const truncate = (body, at) => body.length <= at ? body : `${body.slice(0, at)}…[truncated ${body.length} chars]`;
const nudgeTools = (nudge, log) => typeof nudge.tools === "function" ? nudge.tools(log) : nudge.tools ?? [];
const activeNudges = (render, log) => render.nudges.filter((nudge) => nudge.when(log));
const toolSurface = (render, log) => {
	const active = activeNudges(render, log);
	const withdrawn = new Set(active.flatMap((nudge) => nudge.withdraws ?? []));
	const base = withdrawn.has("*") ? [] : render.tools.filter((tool) => !withdrawn.has(tool.name));
	const offered = active.flatMap((nudge) => nudgeTools(nudge, log));
	const seen = /* @__PURE__ */ new Set();
	const surface = [];
	for (const tool of [...base, ...offered]) {
		if (seen.has(tool.name)) continue;
		seen.add(tool.name);
		surface.push(tool);
	}
	return surface;
};
const systemPrompt = (render, log) => [...render.instructions.map((instruction) => instruction.text), ...activeNudges(render, log).filter((nudge) => nudge.placement === "system").map((nudge) => nudge.text)].filter((fragment) => fragment !== "").join("\n\n");
const tailNudgeMessages = (render, log) => activeNudges(render, log).filter((nudge) => nudge.placement !== "system").map((nudge) => ({
	role: "system",
	content: nudge.text
}));
const renderMessages = (render, log) => {
	const messages = [];
	let pendingText = null;
	for (const event of log) switch (event.type) {
		case "MessageReceived":
			messages.push({
				role: "user",
				content: truncate(String(event.text ?? ""), render.messageTruncateAt)
			});
			break;
		case "TextReturned":
			pendingText = String(event.text ?? "");
			break;
		case "ToolCalled":
			messages.push({
				role: "assistant",
				content: pendingText,
				toolCalls: [{
					id: String(event.callId ?? ""),
					name: String(event.name ?? ""),
					arguments: JSON.stringify(event.arguments ?? {})
				}]
			});
			pendingText = null;
			break;
		case "ToolReturned": {
			const body = event.error === void 0 ? JSON.stringify(event.result ?? null) : JSON.stringify({ error: String(event.error) });
			messages.push({
				role: "tool",
				toolCallId: String(event.callId ?? ""),
				content: truncate(body, render.resultTruncateAt)
			});
			break;
		}
		case "TurnCompleted":
			messages.push({
				role: "assistant",
				content: String(event.output ?? "")
			});
			break;
		case "TurnFailed": messages.push({
			role: "assistant",
			content: `the turn failed: ${String(event.error ?? "")}`
		});
	}
	return messages;
};
const modelRequest = (program, log) => {
	const checkpoint = checkpointOf(log);
	const suffix = servedLog(log.slice(checkpoint.upTo));
	const summary = checkpoint.summary === "" ? [] : [{
		role: "user",
		content: `Summary of earlier work:\n${checkpoint.summary}`
	}];
	return {
		system: systemPrompt(program.render, log),
		messages: [
			...summary,
			...renderMessages(program.render, suffix),
			...tailNudgeMessages(program.render, log)
		],
		tools: toolSurface(program.render, log)
	};
};
//#endregion
//#region packages/harness/src/module.ts
const defineModule = (module) => module;
const undeclaredEvents = (program, log) => [...new Set(log.map((event) => event.type))].filter((type) => !program.events.includes(type)).sort();
const privateLog = (seed) => {
	const rows = [];
	const keys = /* @__PURE__ */ new Set();
	const put = (events) => {
		for (const event of events) {
			const key = keyOf(event);
			if (key !== void 0 && keys.has(key)) continue;
			if (key !== void 0) keys.add(key);
			rows.push(event);
		}
	};
	put(seed);
	return {
		append: (events) => Effect.sync(() => put(events)),
		read: Effect.sync(() => [...rows]),
		readFrom: (from) => Effect.sync(() => rows.slice(from)),
		head: Effect.sync(() => rows.length)
	};
};
const headOf = (message, program, at) => ({
	type: "MessageReceived",
	id: message.id,
	text: message.text,
	program: program.id,
	...message.output === void 0 ? {} : { output: message.output },
	...message.budget === void 0 ? {} : { budget: message.budget },
	...message.escalatable === void 0 ? {} : { escalatable: message.escalatable },
	...message.replyTo === void 0 ? {} : { replyTo: message.replyTo },
	at
});
const resultOf = (log, turn) => ({
	...boundaryOf(log, turn) ?? { kind: "open" },
	turn,
	usage: usageIn(log, turn)
});
const lastTurnOf = (log) => {
	const open = turnHead(log);
	if (open !== void 0) return String(open.id ?? "");
	const heads = log.filter((event) => event.type === "MessageReceived");
	return String(heads[heads.length - 1]?.id ?? "");
};
const build = (program, bound) => {
	const machines = actor(program.machines);
	const scoped = (effect) => bound === void 0 ? effect : effect.pipe(Effect.provideService(EventLog, bound.store), Effect.provideService(Self, bound.id));
	const held = (work) => Effect.gen(function* () {
		return yield* (yield* Writer).hold(yield* Self, work);
	});
	const branch = (recorded, options = {}) => {
		const upTo = Math.max(0, Math.min(options.at ?? recorded.length, recorded.length));
		const seed = recorded.slice(0, upTo);
		return build(program, {
			id: options.id ?? `branch:${program.id}:${upTo}`,
			store: privateLog(seed)
		});
	};
	return {
		program,
		turn: (message) => scoped(held(Effect.gen(function* () {
			const store = yield* EventLog;
			const at = yield* Clock.currentTimeMillis;
			yield* send(machines, headOf(message, program, at));
			return resultOf(yield* store.read, message.id);
		}))),
		log: bound === void 0 ? Effect.flatMap(EventLog, (store) => store.read) : bound.store.read,
		replay: (recorded) => scoped(held(Effect.gen(function* () {
			const store = yield* EventLog;
			yield* store.append(recorded);
			yield* settleAll(machines.machines);
			const log = yield* store.read;
			return resultOf(log, lastTurnOf(log));
		}))),
		request: (log) => modelRequest(program, log),
		read: (signal, log) => readSignal(program, signal, log),
		branch,
		fork: (options = {}) => {
			if (bound !== void 0) return Effect.map(bound.store.read, (recorded) => branch(recorded, {
				...options,
				id: options.id ?? `${bound.id}:fork:${options.at ?? recorded.length}`
			}));
			return Effect.gen(function* () {
				const recorded = yield* (yield* EventLog).read;
				const session = yield* Self;
				return branch(recorded, {
					...options,
					id: options.id ?? `${session}:fork:${options.at ?? recorded.length}`
				});
			});
		}
	};
};
const compile = (modules, options) => {
	const ids = /* @__PURE__ */ new Set();
	const announcements = /* @__PURE__ */ new Map();
	for (const module of modules) {
		if (ids.has(module.id)) throw new Error(`duplicate module id "${module.id}"`);
		ids.add(module.id);
		for (const provided of module.provides ?? []) {
			if (announcements.has(provided.signal.id)) throw new Error(`signal "${provided.signal.id}" is announced by more than one module`);
			announcements.set(provided.signal.id, provided);
		}
	}
	const parts = modules.map((module) => {
		for (const required of module.requires ?? []) if (!announcements.has(required.id)) throw new Error(`module "${module.id}" requires missing signal "${required.id}"`);
		return module.setup({ read: (signal, log) => {
			const found = announcements.get(signal.id);
			if (found === void 0) throw new Error(`no module announces signal "${signal.id}"`);
			return found.read(log);
		} });
	});
	const toolNames = /* @__PURE__ */ new Set();
	const instructionIds = /* @__PURE__ */ new Set();
	for (const part of parts) {
		for (const tool of part.tools ?? []) {
			if (toolNames.has(tool.name)) throw new Error(`duplicate tool name "${tool.name}"`);
			toolNames.add(tool.name);
		}
		for (const instruction of part.instructions ?? []) {
			if (instructionIds.has(instruction.id)) throw new Error(`duplicate instruction id "${instruction.id}"`);
			instructionIds.add(instruction.id);
		}
	}
	const render = parts.reduce((plan, part) => ({
		...plan,
		...part.render,
		instructions: [...plan.instructions, ...part.instructions ?? []],
		tools: [...plan.tools, ...part.tools ?? []],
		nudges: [...plan.nudges, ...part.nudges ?? []]
	}), {
		instructions: [],
		tools: [],
		nudges: [],
		messageTruncateAt: 12e3,
		resultTruncateAt: 6e3
	});
	const manifests = modules.map((module) => ({
		id: module.id,
		version: module.version ?? "1",
		...module.fingerprint === void 0 ? {} : { fingerprint: module.fingerprint }
	}));
	const machines = parts.flatMap((part) => typeof part.machines === "function" ? part.machines(render) : part.machines ?? []);
	const machineIds = /* @__PURE__ */ new Set();
	for (const machine of machines) {
		if (machineIds.has(machine.id)) throw new Error(`duplicate machine id "${machine.id}"`);
		machineIds.add(machine.id);
	}
	return {
		id: options.id ?? programId(manifests),
		...options.parent === void 0 ? {} : { parent: options.parent },
		modules: manifests,
		events: [...new Set(parts.flatMap((part) => part.events ?? []))].sort(),
		machines,
		render,
		announcements: [...announcements.values()]
	};
};
const createAgent = (options) => {
	const modules = options.modules;
	const program = compile(modules, options);
	return build(program);
};
//#endregion
//#region packages/harness/src/exits.ts
const ANSWER = "answer";
const REQUEST_BUDGET = "request-budget";
const EXITS = /* @__PURE__ */ new Set([ANSWER, REQUEST_BUDGET]);
const budgetOf = (log, fallback = 40) => {
	const view = turnView(log);
	const declared = turnHead(view)?.budget;
	const base = typeof declared === "number" && declared > 0 ? Math.floor(declared) : fallback;
	return view.reduce((total, event) => event.type === "BudgetGranted" ? total + Number(event.amount ?? 0) : total, base);
};
const usedOf = (log) => turnView(log).filter((event) => event.type === "ToolCalled" && !EXITS.has(String(event.name ?? ""))).length;
const escalatableOf = (log) => turnHead(turnView(log))?.escalatable === true;
const budgetPhase = (log) => {
	const view = turnView(log);
	for (let index = view.length - 1; index >= 0; index--) {
		const type = view[index]?.type;
		if (type === "BudgetExhausted") return "exhausted";
		if (type === "BudgetDenied") return "denied";
		if (type === "BudgetGranted") return "spending";
		if (type === "MessageReceived") return "spending";
	}
	return "spending";
};
const budgetSpent = (log) => budgetPhase(log) !== "spending";
const canRequestBudget = (log) => budgetPhase(log) === "exhausted" && escalatableOf(log);
const budgetMachine = (defaultBudget) => machine({
	id: "budget",
	view: turnView,
	initial: "spending",
	states: {
		spending: { on: { ToolCalled: {
			target: "exhausted",
			when: (log) => usedOf(log) > budgetOf(log, defaultBudget)
		} } },
		exhausted: {
			decide: (log, now) => [{
				type: "BudgetExhausted",
				turn: turnOf(log),
				budget: budgetOf(log, defaultBudget),
				used: usedOf(log),
				at: now
			}],
			on: { BudgetExhausted: "spent" }
		},
		spent: { on: { BudgetGranted: "spending" } }
	}
});
const askOf = (context) => {
	if (context.callId === void 0) throw new Error("the escalation is active with no ask in context");
	return context;
};
const isEscalation = (log) => String(log[log.length - 1]?.name ?? "") === REQUEST_BUDGET;
const escalationMachine = machine({
	id: "escalation",
	view: turnView,
	initial: "idle",
	context: {},
	states: {
		idle: { on: { ToolCalled: {
			target: "requesting",
			when: isEscalation,
			assign: (_, event) => {
				const args = event.arguments;
				const asked = Number(args?.amount ?? 0);
				return {
					callId: String(event.callId ?? ""),
					reason: String(args?.reason ?? ""),
					amount: asked > 0 ? Math.floor(asked) : 0,
					turn: String(event.turn ?? "")
				};
			}
		} } },
		requesting: {
			decide: (_log, now, context) => {
				const ask = askOf(context);
				return [{
					type: "BudgetRequested",
					turn: ask.turn,
					callId: ask.callId,
					reason: ask.reason,
					amount: ask.amount,
					at: now
				}];
			},
			on: { BudgetRequested: "parked" }
		},
		parked: { on: {
			BudgetGranted: {
				target: "granting",
				assign: (context, event) => ({
					...context,
					grant: Number(event.amount ?? 0)
				})
			},
			BudgetDenied: {
				target: "denying",
				assign: (context, event) => ({
					...context,
					denial: String(event.reason ?? "")
				})
			}
		} },
		granting: {
			decide: (_log, now, context) => {
				const ask = askOf(context);
				return [{
					type: "ToolReturned",
					turn: ask.turn,
					callId: ask.callId,
					name: REQUEST_BUDGET,
					result: { granted: ask.grant ?? 0 },
					at: now
				}];
			},
			on: { ToolReturned: "idle" }
		},
		denying: {
			decide: (_log, now, context) => {
				const ask = askOf(context);
				return [{
					type: "ToolReturned",
					turn: ask.turn,
					callId: ask.callId,
					name: REQUEST_BUDGET,
					result: {
						denied: true,
						...ask.denial === void 0 || ask.denial === "" ? {} : { reason: ask.denial },
						note: "No more budget. Answer now with your best result."
					},
					at: now
				}];
			},
			on: { ToolReturned: "idle" }
		}
	}
});
const WALL_TEXT = "Your tool budget for this turn is spent, so the work tools are gone. Answer now with your best result from what you have already gathered.";
const ESCALATE_TEXT = "If the work genuinely needs more and the extra spend is worth it, call request-budget with a reason and an amount instead of answering. Ask only when it changes the result.";
const requestBudgetTool = (description) => ({
	name: REQUEST_BUDGET,
	description,
	inputSchema: {
		type: "object",
		properties: {
			reason: {
				type: "string",
				description: "What is still missing and what the calls are for."
			},
			amount: {
				type: "number",
				description: "How many more tool calls you need."
			}
		},
		required: ["reason", "amount"],
		additionalProperties: false
	}
});
const REQUEST_DESCRIPTION = "Ask for more tool-call budget when the work is not done and the budget is spent. State why the extra spend is worth it and how many more calls you need. The parent decides: a grant lets you keep working, a denial means finish with what you have.";
const budget = (options = {}) => {
	const defaultBudget = options.defaultBudget ?? 40;
	const wallText = options.wallText ?? WALL_TEXT;
	const escalateText = options.escalateText ?? ESCALATE_TEXT;
	const requestTool = requestBudgetTool(options.requestDescription ?? REQUEST_DESCRIPTION);
	const wallNudge = {
		id: "budget.wall",
		when: budgetSpent,
		text: wallText,
		withdraws: ["*"]
	};
	const escalateNudge = {
		id: "budget.escalate",
		when: canRequestBudget,
		text: escalateText,
		tools: [requestTool]
	};
	return defineModule({
		id: "budget",
		version: "2",
		fingerprint: {
			defaultBudget,
			wallText,
			escalateText,
			requestTool
		},
		setup: () => ({
			events: [
				"BudgetExhausted",
				"BudgetRequested",
				"BudgetGranted",
				"BudgetDenied"
			],
			machines: [budgetMachine(defaultBudget), erase(escalationMachine)],
			nudges: [wallNudge, escalateNudge]
		})
	});
};
//#endregion
//#region packages/harness/src/providers/environment.ts
const environment = (name) => {
	const value = typeof process === "undefined" ? void 0 : process.env[name];
	return value === void 0 || value === "" ? void 0 : value;
};
const environmentNumber = (name) => {
	const value = environment(name);
	if (value === void 0) return void 0;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : void 0;
};
//#endregion
//#region packages/harness/src/providers/openai-chat.ts
const tool = (spec) => ({
	type: "function",
	function: {
		name: spec.name,
		description: spec.description,
		parameters: spec.inputSchema
	}
});
const message = (one) => one.role === "assistant" && one.toolCalls !== void 0 ? {
	role: one.role,
	content: one.content,
	tool_calls: one.toolCalls.map((call) => ({
		id: call.id,
		type: "function",
		function: {
			name: call.name,
			arguments: call.arguments
		}
	}))
} : one.role === "tool" ? {
	role: one.role,
	content: one.content,
	tool_call_id: one.toolCallId
} : {
	role: one.role,
	content: one.content
};
const usageOf = (usage) => ({
	promptTokens: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : 0,
	completionTokens: typeof usage?.completion_tokens === "number" ? usage.completion_tokens : 0,
	costUsd: typeof usage?.cost_usd === "number" ? usage.cost_usd : typeof usage?.cost === "number" ? usage.cost : 0
});
const argumentsOf = (value) => {
	if (typeof value !== "string") return value ?? {};
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
};
const actionOf = (body) => {
	const failure = body.error?.message;
	if (failure !== void 0) return {
		kind: "fail",
		error: String(failure)
	};
	const answer = body.choices?.[0]?.message;
	if (answer === void 0) return {
		kind: "fail",
		error: "the inference gateway returned no choice"
	};
	const usage = usageOf(body.usage);
	const call = answer.tool_calls?.[0];
	if (call !== void 0) {
		const name = call.function?.name;
		const id = call.id;
		if (typeof name !== "string" || typeof id !== "string") return {
			kind: "fail",
			error: "the inference gateway returned a malformed tool call",
			usage
		};
		return {
			kind: "call",
			callId: id,
			name,
			arguments: argumentsOf(call.function?.arguments),
			text: typeof answer.content === "string" ? answer.content : void 0,
			usage
		};
	}
	return {
		kind: "complete",
		output: typeof answer.content === "string" ? answer.content : "",
		usage
	};
};
const openAiChatInference = (options) => ({
	id: options.id,
	state: () => ({
		provider: options.provider,
		model: options.model,
		contextWindow: options.contextWindow
	}),
	react: (request, key) => {
		if (options.configurationError !== void 0) return Effect.succeed({
			kind: "fail",
			error: options.configurationError
		});
		const call = options.fetch ?? fetch;
		return Effect.tryPromise({
			try: async () => {
				const response = await call(options.endpoint, {
					method: "POST",
					headers: {
						authorization: `Bearer ${options.apiKey ?? ""}`,
						"content-type": "application/json",
						"idempotency-key": key,
						...options.headers
					},
					body: JSON.stringify({
						model: options.model,
						messages: [...request.system === "" ? [] : [{
							role: "system",
							content: request.system
						}], ...request.messages.map(message)],
						...request.tools.length === 0 ? {} : { tools: request.tools.map(tool) }
					})
				});
				const text = await response.text();
				if (!response.ok) return {
					kind: "fail",
					error: `${options.provider} returned HTTP ${response.status}: ${text}`
				};
				return actionOf(JSON.parse(text));
			},
			catch: (error) => error instanceof Error ? error : new Error(String(error))
		}).pipe(Effect.catchAll((error) => Effect.succeed({
			kind: "fail",
			error: `${options.provider} request failed: ${error.message}`
		})), Effect.catchAllDefect((defect) => Effect.succeed({
			kind: "fail",
			error: `${options.provider} request failed: ${String(defect)}`
		})));
	}
});
//#endregion
//#region packages/harness/src/providers/vercel-gateway.ts
const vercelGatewayInference = (options = {}) => {
	const configured = options.apiKey ?? environment("AI_GATEWAY_API_KEY");
	const apiKey = configured === "" ? void 0 : configured;
	const model = options.model ?? environment("AI_GATEWAY_MODEL") ?? "anthropic/claude-sonnet-4.6";
	const contextWindow = options.contextWindow ?? environmentNumber("AI_GATEWAY_CONTEXT_WINDOW") ?? 2e5;
	const baseUrl = options.baseUrl ?? "https://ai-gateway.vercel.sh/v1";
	return openAiChatInference({
		id: `vercel-ai-gateway:${model}`,
		provider: "vercel-ai-gateway",
		model,
		contextWindow,
		endpoint: `${baseUrl.replace(/\/$/, "")}/chat/completions`,
		...apiKey === void 0 ? {} : { apiKey },
		...options.fetch === void 0 ? {} : { fetch: options.fetch },
		...apiKey === void 0 ? { configurationError: "Vercel AI Gateway needs AI_GATEWAY_API_KEY or an apiKey passed to vercelGatewayInference" } : {}
	});
};
//#endregion
//#region packages/harness/src/modules/inference.ts
const BASE_SYSTEM = "You are an agent. Read the conversation, use the tools you are offered when they help, and answer the person who wrote to you. When the work is done, reply in plain text: that reply is your final answer and it ends the turn.";
const inferenceState = signal("inference.state");
const diedAttempts = (view) => {
	let died = 0;
	for (let index = view.length - 1; index >= 0; index--) {
		if (view[index]?.type !== "ModelCalled") break;
		died += 1;
	}
	return died;
};
const consequenceOf = (action, turn, at) => action.kind === "call" ? {
	type: "ToolCalled",
	turn,
	callId: action.callId,
	name: action.name,
	arguments: action.arguments,
	at
} : action.kind === "complete" ? {
	type: "TurnCompleted",
	turn,
	output: action.output,
	at
} : {
	type: "TurnFailed",
	turn,
	error: action.error,
	at
};
const inferMachine = (render, selection, giveUpAfter, repairAtMost) => machine({
	id: "inference",
	initial: "idle",
	context: { turn: "" },
	view: turnView,
	states: {
		idle: { on: { MessageReceived: {
			target: "thinking",
			assign: (_, event) => ({ turn: String(event.id ?? "") })
		} } },
		thinking: {
			act: (log, context) => Effect.gen(function* () {
				const turn = context.turn;
				const view = turnView(log);
				const at = yield* Clock.currentTimeMillis;
				const died = diedAttempts(view);
				if (died >= giveUpAfter) return [{
					type: "TurnFailed",
					turn,
					error: `the model attempt died ${giveUpAfter} times in a row`,
					at
				}];
				if (view.filter((event) => event.type === "AnswerRejected").length > repairAtMost) return [{
					type: "TurnFailed",
					turn,
					error: `the answer did not satisfy the declared schema after ${repairAtMost} corrections`,
					at
				}];
				const key = `${turn}/infer/${view.filter((event) => event.type === "ModelCalled").length - died}`;
				yield* (yield* EventLog).append([{
					type: "ModelCalled",
					turn,
					callId: key,
					at
				}]);
				const override = yield* Effect.serviceOption(Infer);
				const action = yield* Option.getOrElse(override, () => selectedInference(selection, log)).react(modelRequest({ render }, log), key);
				const after = yield* Clock.currentTimeMillis;
				return [
					{
						type: "ModelReturned",
						turn,
						callId: key,
						usage: usageOf$1(action.usage),
						at: after
					},
					...action.kind === "call" && action.text !== void 0 && action.text !== "" ? [{
						type: "TextReturned",
						turn,
						text: action.text,
						at: after
					}] : [],
					consequenceOf(action, turn, after)
				];
			}),
			on: {
				ToolCalled: "waiting",
				TurnCompleted: "idle",
				TurnFailed: "idle"
			}
		},
		waiting: { on: { ToolReturned: "thinking" } }
	}
});
const replyMachine = machine({
	id: "reply",
	view: replyView,
	initial: "idle",
	states: {
		idle: { on: { MessageReceived: "open" } },
		open: { on: {
			TurnCompleted: "replying",
			TurnFailed: "replying"
		} },
		replying: {
			act: (log) => Effect.gen(function* () {
				const view = replyView(log);
				const head = view[0];
				const terminal = view.find((event) => event.type === "TurnCompleted" || event.type === "TurnFailed");
				if (head === void 0 || terminal === void 0) return yield* Effect.die(/* @__PURE__ */ new Error("replying with no finished turn: the fold and the machine disagree"));
				const turn = String(head.id ?? "");
				const at = yield* Clock.currentTimeMillis;
				if (head.replyTo === void 0) return [{
					type: "ReplyDelivered",
					turn,
					at
				}];
				const to = String(head.replyTo);
				const failed = terminal.type === "TurnFailed";
				yield* (yield* Router).deliver(to, {
					type: "MessageReceived",
					id: `reply:${turn}`,
					text: failed ? `error: ${String(terminal.error ?? "")}` : String(terminal.output ?? ""),
					outcome: failed ? "failed" : "completed",
					at
				});
				return [{
					type: "ReplyDelivered",
					turn,
					to,
					at
				}];
			}),
			on: { ReplyDelivered: "idle" }
		}
	}
});
const inference = (options = {}) => {
	const selection = options.provider ?? vercelGatewayInference();
	const system = options.system ?? BASE_SYSTEM;
	const giveUpAfter = options.giveUpAfter ?? 3;
	const repairAtMost = options.repairAtMost ?? 2;
	const messageTruncateAt = options.messageTruncateAt ?? 12e3;
	const resultTruncateAt = options.resultTruncateAt ?? 6e3;
	const initial = selectedInference(selection, []);
	return defineModule({
		id: "inference",
		version: "2",
		fingerprint: {
			provider: initial.id,
			state: initial.state([]),
			system,
			giveUpAfter,
			repairAtMost,
			messageTruncateAt,
			resultTruncateAt
		},
		provides: [announce(inferenceState, (log) => {
			return selectedInference(selection, log).state(log);
		})],
		setup: () => ({
			events: [
				"MessageReceived",
				"ModelCalled",
				"ModelReturned",
				"TextReturned",
				"TurnCompleted",
				"TurnFailed",
				"ReplyDelivered"
			],
			instructions: [{
				id: "inference.system",
				text: system
			}],
			render: {
				messageTruncateAt,
				resultTruncateAt
			},
			machines: (render) => [erase(inferMachine(render, selection, giveUpAfter, repairAtMost)), replyMachine]
		})
	});
};
//#endregion
//#region packages/harness/src/modules/compaction.ts
const TRIGGER_RATIO = .8;
const KEEP_RATIO = .2;
const COMPRESSION_RATIO = .5;
const MORPH_URL = "https://api.morphllm.com/v1";
const naiveSummary = (input, ratio) => {
	const tidy = input.split("\n").map((line) => line.trimEnd()).filter((line) => line !== "").join("\n");
	const budget = Math.max(1, Math.floor(input.length * ratio));
	if (tidy.length <= budget) return tidy;
	return `${tidy.slice(0, budget)}\n[compaction fallback: ${tidy.length - budget} chars elided; the log keeps the full history]`;
};
const compress = (options, input, query, ratio) => {
	const fallback = {
		summary: naiveSummary(input, ratio),
		provider: "fallback"
	};
	const apiKey = options.apiKey ?? environment("MORPH_API_KEY");
	if (apiKey === void 0) return Effect.succeed(fallback);
	const call = options.fetch ?? fetch;
	return Effect.tryPromise({
		try: async () => {
			const response = await call(`${options.apiUrl ?? MORPH_URL}/compact`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${apiKey}`,
					"content-type": "application/json"
				},
				body: JSON.stringify({
					input,
					query,
					compression_ratio: ratio,
					preserve_recent: 0
				})
			});
			if (!response.ok) throw new Error(`morph compact failed with HTTP ${response.status}`);
			const body = await response.json();
			if (typeof body.output !== "string") throw new Error("morph compact returned no output");
			return {
				summary: body.output,
				provider: "morph"
			};
		},
		catch: (error) => error instanceof Error ? error : new Error(String(error))
	}).pipe(Effect.catchAll(() => Effect.succeed(fallback)), Effect.catchAllDefect(() => Effect.succeed(fallback)));
};
const lastQuestion = (log) => {
	for (let index = log.length - 1; index >= 0; index--) {
		const event = log[index];
		if (event?.type === "MessageReceived") return String(event.text ?? "");
	}
	return "";
};
const morphCompaction = (options = {}) => {
	const triggerAt = options.triggerAt ?? .8;
	const keepAt = options.keepAt ?? .2;
	const ratio = options.compressionRatio ?? .5;
	return defineModule({
		id: "compaction",
		version: "2",
		fingerprint: {
			triggerAt,
			keepAt,
			fireTokens: options.fireTokens,
			keepTokens: options.keepTokens,
			ratio,
			apiUrl: options.apiUrl ?? MORPH_URL,
			morph: (options.apiKey ?? environment("MORPH_API_KEY")) !== void 0
		},
		requires: [inferenceState],
		setup: (context) => {
			const thresholds = (log) => {
				const window = context.read(inferenceState, log).contextWindow;
				return {
					fire: options.fireTokens ?? Math.max(1, Math.floor(window * triggerAt)),
					keep: options.keepTokens ?? Math.max(1, Math.floor(window * keepAt))
				};
			};
			const overContext = (log) => estimateTokens(suffixOf(log)) > thresholds(log).fire;
			return {
				events: ["CompactionFired", "CompactionCompleted"],
				machines: [machine({
					id: "compaction",
					initial: "idle",
					states: {
						idle: { on: {
							ReplyDelivered: {
								target: "compacting",
								when: overContext
							},
							CompactionFired: "compacting"
						} },
						compacting: {
							act: (log) => Effect.gen(function* () {
								const at = yield* Clock.currentTimeMillis;
								const prior = checkpointOf(log);
								const upTo = Math.max(prior.upTo, keepUpTo(log, thresholds(log).keep));
								const span = log.slice(prior.upTo, upTo);
								if (span.length === 0) return [{
									type: "CompactionCompleted",
									upTo: prior.upTo,
									summary: prior.summary,
									provider: "fallback",
									at
								}];
								const input = [prior.summary === "" ? "" : `Summary so far: ${prior.summary}`, transcript(span)].filter((part) => part !== "").join("\n\n");
								const compacted = yield* compress(options, input, lastQuestion(log), ratio);
								return [{
									type: "CompactionCompleted",
									upTo,
									summary: compacted.summary,
									provider: compacted.provider,
									at
								}];
							}),
							on: { CompactionCompleted: "idle" }
						}
					}
				})]
			};
		}
	});
};
//#endregion
//#region packages/harness/src/schema.ts
const kindOf = (value) => {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
};
const matches = (expected, value) => {
	if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
	return expected === kindOf(value);
};
const at = (path) => path === "" ? "/" : path;
const walk = (schema, value, path, errors) => {
	if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return;
	const rules = schema;
	const declared = typeof rules.type === "string" ? [rules.type] : Array.isArray(rules.type) ? rules.type.filter((one) => typeof one === "string") : [];
	if (declared.length > 0 && !declared.some((one) => matches(one, value))) {
		errors.push(`${at(path)}: expected ${declared.join(" or ")}, got ${kindOf(value)}`);
		return;
	}
	if (Array.isArray(rules.enum)) {
		const encoded = JSON.stringify(value);
		if (!rules.enum.some((one) => JSON.stringify(one) === encoded)) errors.push(`${at(path)}: expected one of ${JSON.stringify(rules.enum)}`);
	}
	if (kindOf(value) === "object") {
		const record = value;
		const properties = rules.properties !== null && typeof rules.properties === "object" ? rules.properties : {};
		if (Array.isArray(rules.required)) {
			for (const name of rules.required) if (typeof name === "string" && record[name] === void 0) errors.push(`${path}/${name}: required`);
		}
		for (const [name, sub] of Object.entries(properties)) if (record[name] !== void 0) walk(sub, record[name], `${path}/${name}`, errors);
		if (rules.additionalProperties === false) {
			for (const name of Object.keys(record)) if (!(name in properties)) errors.push(`${path}/${name}: not allowed here`);
		}
	}
	if (Array.isArray(value) && rules.items !== void 0) value.forEach((item, index) => walk(rules.items, item, `${path}/${index}`, errors));
};
const answerErrors = (schema, answer) => {
	if (schema === void 0 || schema === null || typeof schema !== "object") return [];
	const errors = [];
	walk(schema, answer === void 0 ? {} : answer, "", errors);
	return errors;
};
const repairText = (errors) => `Your answer did not match this turn's output schema:\n${errors.map((one) => `- ${one}`).join("\n")}\nCall the answer tool again with arguments that satisfy the schema. Send values in their declared types: an array is a JSON array, never a string holding one.`;
//#endregion
//#region packages/harness/src/modules/contract.ts
const outputSchemaOf = (log) => turnHead(turnView(log))?.output;
const declaresOutput = (log) => outputSchemaOf(log) !== void 0;
const ANSWER_TEXT = "This turn declares an output schema. Finish by calling the answer tool: its arguments are your final answer and must satisfy that schema. Do not answer in prose.";
const ANSWER_DESCRIPTION = "Deliver the final answer for this turn. The arguments are the answer.";
const answerTool = (log, description) => {
	const schema = outputSchemaOf(log);
	return schema === void 0 ? [] : [{
		name: ANSWER,
		description,
		inputSchema: schema
	}];
};
const answerOf = (context) => {
	if (context.callId === void 0) throw new Error("the contract is judging with no answer in context");
	return context;
};
const isAnswer = (log) => String(log[log.length - 1]?.name ?? "") === ANSWER;
const contractMachine = machine({
	id: "contract",
	view: turnView,
	initial: "idle",
	context: {},
	states: {
		idle: { on: { ToolCalled: {
			target: "judging",
			when: isAnswer,
			assign: (_, event) => ({
				callId: String(event.callId ?? ""),
				arguments: event.arguments,
				turn: String(event.turn ?? "")
			})
		} } },
		judging: {
			decide: (log, now, context) => {
				const answer = answerOf(context);
				const turn = answer.turn === "" ? turnOf(log) : answer.turn;
				const errors = answerErrors(outputSchemaOf(log), answer.arguments);
				if (errors.length === 0) return [{
					type: "ToolReturned",
					turn,
					callId: answer.callId,
					name: ANSWER,
					result: { accepted: true },
					at: now
				}, {
					type: "TurnCompleted",
					turn,
					output: JSON.stringify(answer.arguments ?? null),
					at: now
				}];
				return [{
					type: "AnswerRejected",
					turn,
					callId: answer.callId,
					error: errors.join("; "),
					at: now
				}, {
					type: "ToolReturned",
					turn,
					callId: answer.callId,
					name: ANSWER,
					result: null,
					error: repairText(errors),
					at: now
				}];
			},
			on: { ToolReturned: "idle" }
		}
	}
});
const contract = (options = {}) => {
	const text = options.nudge ?? ANSWER_TEXT;
	const description = options.answerDescription ?? ANSWER_DESCRIPTION;
	const answerNudge = {
		id: "contract.answer",
		when: declaresOutput,
		text,
		tools: (log) => answerTool(log, description)
	};
	return defineModule({
		id: "contract",
		version: "2",
		fingerprint: {
			text,
			description
		},
		setup: () => ({
			events: ["AnswerRejected"],
			machines: [erase(contractMachine)],
			nudges: [answerNudge]
		})
	});
};
//#endregion
//#region packages/harness/src/modules/tools.ts
const callOf = (context) => {
	if (context.callId === void 0) throw new Error("the tools machine is dispatching with no call in context");
	return context;
};
const claimable = (log) => {
	const call = log[log.length - 1];
	return call !== void 0 && !EXITS.has(String(call.name ?? ""));
};
const WALL_REFUSAL = "Tool budget reached. Do not call this tool again. Answer now with your best result from what you have already gathered.";
const toolsMachine = (handlers) => machine({
	id: "tools",
	view: turnView,
	initial: "idle",
	context: {},
	states: {
		idle: { on: { ToolCalled: {
			target: "dispatching",
			when: claimable,
			assign: (_, event) => ({
				callId: String(event.callId ?? ""),
				name: String(event.name ?? ""),
				arguments: event.arguments,
				turn: String(event.turn ?? "")
			})
		} } },
		dispatching: {
			act: (log, context) => Effect.gen(function* () {
				const call = callOf(context);
				const answer = (result, error) => [{
					type: "ToolReturned",
					turn: call.turn,
					callId: call.callId,
					name: call.name,
					result,
					...error === void 0 ? {} : { error }
				}];
				const at = yield* Clock.currentTimeMillis;
				const stamped = (events) => events.map((event) => ({
					...event,
					at
				}));
				if (budgetSpent(log)) return stamped(answer(null, WALL_REFUSAL));
				const tool = handlers.get(call.name);
				if (tool === void 0) return stamped(answer(null, `unknown tool: ${call.name}`));
				const outcome = yield* Effect.exit(tool.run(call.arguments, {
					turn: call.turn,
					callId: call.callId
				}));
				return stamped(Exit.isSuccess(outcome) ? answer(outcome.value) : answer(null, Cause.pretty(outcome.cause)));
			}),
			on: { ToolReturned: "idle" }
		}
	}
});
const tools = (list) => {
	const handlers = new Map(list.map((tool) => [tool.spec.name, tool]));
	return defineModule({
		id: "tools",
		version: "2",
		fingerprint: list.map((tool) => tool.spec),
		setup: () => ({
			events: ["ToolCalled", "ToolReturned"],
			machines: [erase(toolsMachine(handlers))],
			tools: list.map((tool) => tool.spec)
		})
	});
};
const agentTool = (options) => ({
	spec: {
		name: options.name,
		description: options.description,
		inputSchema: options.inputSchema ?? {
			type: "object",
			properties: { message: { type: "string" } },
			required: ["message"],
			additionalProperties: false
		}
	},
	run: (input, context) => Effect.gen(function* () {
		const router = yield* Router;
		const message = options.message?.(input) ?? String(input?.message ?? input);
		const callId = options.callId?.(input, context) ?? (context === void 0 ? `${options.name}:${sha256(canonicalValue(input)).slice(0, 16)}` : `${options.name}:${context.turn}:${context.callId}`);
		const terminal = yield* router.call(options.address, {
			type: "MessageReceived",
			id: callId,
			text: message
		});
		return terminal.type === "TurnCompleted" ? terminal.output : { error: String(terminal.error ?? `sub-agent ended with ${terminal.type}`) };
	})
});
//#endregion
//#region packages/harness/src/pack.ts
const defaultPack = (options = {}) => [
	inference(options.inference),
	tools(options.tools ?? []),
	budget(options.budget),
	contract(options.contract),
	morphCompaction(options.compaction)
];
//#endregion
//#region packages/harness/src/providers/cloudflare-gateway.ts
const cloudflareGatewayInference = (options = {}) => {
	const configuredAccount = options.accountId ?? environment("CLOUDFLARE_ACCOUNT_ID");
	const configuredToken = options.apiToken ?? environment("CLOUDFLARE_API_TOKEN");
	const accountId = configuredAccount === "" ? void 0 : configuredAccount;
	const apiToken = configuredToken === "" ? void 0 : configuredToken;
	const gatewayId = options.gatewayId ?? environment("CLOUDFLARE_AI_GATEWAY_ID");
	const model = options.model ?? environment("CLOUDFLARE_AI_MODEL") ?? "anthropic/claude-sonnet-4";
	const contextWindow = options.contextWindow ?? environmentNumber("CLOUDFLARE_AI_CONTEXT_WINDOW") ?? 2e5;
	const baseUrl = options.baseUrl ?? "https://api.cloudflare.com/client/v4/accounts";
	const missing = [...accountId === void 0 ? ["CLOUDFLARE_ACCOUNT_ID or accountId"] : [], ...apiToken === void 0 ? ["CLOUDFLARE_API_TOKEN or apiToken"] : []];
	return openAiChatInference({
		id: `cloudflare-ai-gateway:${model}`,
		provider: "cloudflare-ai-gateway",
		model,
		contextWindow,
		endpoint: `${baseUrl.replace(/\/$/, "")}/${accountId ?? "missing"}/ai/v1/chat/completions`,
		...apiToken === void 0 ? {} : { apiKey: apiToken },
		...gatewayId === void 0 ? {} : { headers: { "cf-aig-gateway-id": gatewayId } },
		...options.fetch === void 0 ? {} : { fetch: options.fetch },
		...missing.length === 0 ? {} : { configurationError: `Cloudflare AI Gateway needs ${missing.join(" and ")}` }
	});
};
//#endregion
//#region packages/harness/src/modules/nudge.ts
const nudge = (options) => defineModule({
	id: `nudge:${options.id}`,
	version: options.version ?? "1",
	fingerprint: {
		id: options.id,
		text: options.text,
		placement: options.placement ?? "tail"
	},
	setup: () => ({ nudges: [{
		id: options.id,
		when: options.when,
		text: options.text,
		...options.placement === void 0 ? {} : { placement: options.placement },
		...options.tools === void 0 ? {} : { tools: options.tools },
		...options.withdraws === void 0 ? {} : { withdraws: options.withdraws }
	}] })
});
//#endregion
export { Infer as $, modelRequest as A, usageIn as B, usedOf as C, createAgent as D, REQUEST_BUDGET as E, servedLog as F, keyOf as G, estimateTokens as H, transcript as I, signal as J, boundaryOf as K, turnHead as L, systemPrompt as M, toolSurface as N, defineModule as O, replyView as P, readSignal as Q, turnOf as R, escalatableOf as S, EXITS as T, keepUpTo as U, checkpointOf as V, suffixOf as W, canonicalValue as X, WITHDRAW_ALL as Y, programId as Z, budget as _, tools as a, budgetSpent as b, repairText as c, TRIGGER_RATIO as d, customInference as et, morphCompaction as f, vercelGatewayInference as g, inferenceState as h, agentTool as i, renderMessages as j, undeclaredEvents as k, COMPRESSION_RATIO as l, inference as m, cloudflareGatewayInference as n, selectedInference as nt, contract as o, naiveSummary as p, announce as q, defaultPack as r, usageOf$1 as rt, answerErrors as s, nudge as t, inferWith as tt, KEEP_RATIO as u, budgetOf as v, ANSWER as w, canRequestBudget as x, budgetPhase as y, turnView as z };
