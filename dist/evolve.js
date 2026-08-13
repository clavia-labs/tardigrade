import { f as foldOf } from "./src-BDBJZOcw.js";
import { X as canonicalValue, rt as usageOf } from "./src-Sejs7bCE.js";
import { Effect } from "effect";
//#region packages/evolve/src/candidate.ts
const candidate = (id, value, options = {}) => ({
	id,
	value,
	...options.parent === void 0 ? {} : { parent: options.parent },
	...options.source === void 0 ? {} : { source: options.source }
});
//#endregion
//#region packages/evolve/src/observe.ts
const observationOf = (agent, log) => ({
	request: agent.request(log),
	machines: agent.program.machines.map((machine) => ({
		id: machine.id,
		state: foldOf(machine, log).name,
		context: foldOf(machine, log).context
	})),
	dependencies: Object.fromEntries(agent.program.bindings.map((binding) => [binding.token.id, binding.project(log)]))
});
const modelCallPrefixes = (log) => log.flatMap((event, index) => event.type === "ModelCalled" ? [log.slice(0, index)] : []);
const observationallyEquivalent = (left, right, logs) => logs.every((log) => canonicalValue(observationOf(left, log)) === canonicalValue(observationOf(right, log)));
//#endregion
//#region packages/evolve/src/score.ts
const verdictsOf = (log) => log.filter((event) => event.type === "RewardGranted").map((event) => ({
	score: typeof event.score === "number" ? event.score : 0,
	reason: event.reason === void 0 ? "" : String(event.reason)
}));
const scoreOf = (log) => verdictsOf(log).reduce((total, verdict) => total + verdict.score, 0);
const spendOf = (log) => log.filter((event) => event.type === "ModelReturned").map((event) => usageOf(event.usage)).reduce((total, one) => ({
	promptTokens: total.promptTokens + one.promptTokens,
	completionTokens: total.completionTokens + one.completionTokens,
	costUsd: total.costUsd + one.costUsd
}), {
	promptTokens: 0,
	completionTokens: 0,
	costUsd: 0
});
//#endregion
//#region packages/evolve/src/rollout.ts
const marksOf = (log) => log.flatMap((event, index) => event.type === "ModelCalled" ? [index] : []);
const divergence = (recorded, candidate, log) => {
	let replayed = 0;
	for (const at of marksOf(log)) {
		const prefix = log.slice(0, at);
		if (canonicalValue(candidate.request(prefix)) !== canonicalValue(recorded.request(prefix))) return {
			replayed,
			upTo: at
		};
		replayed += 1;
	}
	return {
		replayed,
		upTo: log.length
	};
};
const rollout = (options) => Effect.suspend(() => {
	const { baseline, candidate, log } = options;
	const head = log.find((event) => event.type === "MessageReceived");
	const aligned = head?.program === void 0 || head.program === baseline.program.id ? divergence(baseline, candidate, log) : {
		replayed: 0,
		upTo: marksOf(log)[0] ?? log.length
	};
	const branch = candidate.branch(log.slice(0, aligned.upTo), { id: `rollout:${candidate.program.id}:${aligned.upTo}` });
	return Effect.gen(function* () {
		const seeded = (yield* branch.log).length;
		yield* branch.replay([]);
		const settled = yield* branch.log;
		const tail = settled.slice(seeded);
		return {
			replayed: aligned.replayed,
			called: tail.filter((event) => event.type === "ModelCalled").length,
			usage: spendOf(tail),
			log: settled
		};
	});
});
//#endregion
//#region packages/evolve/src/pareto.ts
const scoreAt = (scores, task) => scores[task] ?? Number.NEGATIVE_INFINITY;
const dominates = (left, right, tasks) => {
	let strictly = false;
	for (const task of tasks) {
		const here = scoreAt(left, task);
		const there = scoreAt(right, task);
		if (here < there) return false;
		if (here > there) strictly = true;
	}
	return strictly;
};
const build = (entries) => {
	const tasks = [...new Set(entries.flatMap((entry) => Object.keys(entry.scores)))];
	const front = entries.filter((entry) => !entries.some((other) => other !== entry && dominates(other.scores, entry.scores, tasks))).map((entry) => entry.value);
	return {
		add: (value, scores) => build([...entries.filter((entry) => entry.value.id !== value.id), {
			value,
			scores
		}]),
		front,
		sample: (rng) => front.length === 0 ? void 0 : front[Math.min(front.length - 1, Math.floor(rng() * front.length))]
	};
};
const paretoArchive = () => build([]);
//#endregion
export { candidate, divergence, modelCallPrefixes, observationOf, observationallyEquivalent, paretoArchive, rollout, scoreOf, spendOf, verdictsOf };
