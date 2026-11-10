import assert from 'node:assert/strict'
import {Effect, Layer} from 'effect'
import {atom, createActorStore, defineActor, abortRequested, Promises, type ActorRuntime, type CoreEvent} from '@clavia/tardigrade-core'
import {actorContext, ModelInfo, ToolCatalog, infer, tools, withToolExecution, withPermissions, permissions, withBudget, toolBudget, pendingTools, Event, requestTurn, Generate, Summarize, ExecuteTool, AskBudget, AskPermission} from '@clavia/tardigrade-agent'

import {test} from 'bun:test'

test('bounded foreground tool batches preserve lifecycle and replay', async () => {
const definition = defineActor('concurrency', Effect.gen(function*(){
  const available = withToolExecution(yield* tools(), {concurrency: 2, group: call => call.name === 'write' ? undefined : {key:'reads',limit:2}})
  const governed = withBudget(withPermissions(available, permissions(pendingTools, {tools: available, policy: {default: permissionMode, actions: {}}})), toolBudget(pendingTools, {maxCalls}))
  return {atom: yield* infer(atom(get => ({system:'',tools:get(governed),context:{view:{position:'ready' as const,messages:[]},events:{},acts:{}}}))),schema: Event}
}))
let generated=0
let maxCalls=10
let permissionMode: "allow" | "ask" = "allow"
const asked: string[] = []
let scenario: readonly string[]=['a','b','c']
const deliveries:string[]=[], stopped:string[]=[], gates=new Map<string,()=>void>()
let runtime!:ActorRuntime<Event>
const open=(events: readonly (Event|CoreEvent)[]=[]) => Effect.runPromise(createActorStore({actor:definition,events,actorContext,services: current => {
  runtime=current
  return Layer.mergeAll(
    Layer.succeed(ModelInfo,{model:{provider:'openai',model_id:'test'},contextWindowTokens:10000}),
    Layer.succeed(ToolCatalog,{names:['read','write'],specs:[]}),
    Generate.layer(() => Effect.sync(()=> ++generated===1 ? {text:'',toolCalls:scenario.map(callId=>({callId,name:callId.startsWith('write')?'write':'read',input:{}}))} : {text:'done',toolCalls:[]})),
    Summarize.layer(()=>Effect.succeed({text:'summary',toolCalls:[]})),
    ExecuteTool.layer(({call,value,error})=> error!==undefined ? Effect.fail(error) : value!==undefined ? Effect.succeed(value) : Effect.callback<string>(resume=>{
      deliveries.push(call.providerId)
      gates.set(call.providerId,()=>resume(Effect.succeed(call.providerId)))
      return Effect.sync(()=>{stopped.push(call.providerId)})
    })),
    AskBudget.layer(()=>Effect.succeed({allowed:false,reason:'no'})),
    AskPermission.layer(input => Effect.sync(() => {asked.push(input.requestId); return {allowed: true, reason: "approved"}})),
    Layer.succeed(Promises,{watch:()=>Effect.void,cancel:()=>Effect.void}),
  )
}}))
const until=async(f:()=>boolean)=>{const end=Date.now()+3000;while(!f()){assert(Date.now()<end, `native calls did not reach the barrier: ${deliveries}`);await Bun.sleep(5)}}
let store=await open()
await Effect.runPromise(runtime.send([requestTurn({text:'run',turnId:'turn',invocationRef:{method:'turn',id:'turn'}})]))
await until(()=>deliveries.length===2)
assert.deepEqual(deliveries,['a','b'])
gates.get('b')!()
await until(()=>store.snapshot().events.some(e=>e.type==='ToolCompleted'))
assert.equal(store.snapshot().events.filter(e=>e.type==='ToolReturned').length,0)
await Bun.sleep(10)
assert.equal(deliveries.length,2, 'the completed-result window stays bounded behind a stalled head')
const checkpoint=[...store.snapshot().events]
await Effect.runPromise(store.close)
store=await open(checkpoint)
await until(()=>deliveries.length===3)
assert.deepEqual(deliveries,['a','b','a'])
gates.get('a')!()
await until(()=>deliveries.length===4)
gates.get('c')!()
await Effect.runPromise(store.wait)
assert.deepEqual(store.snapshot().events.filter(e=>e.type==='ToolReturned').map(e=>e.tool?.providerId),['a','b','c'])
assert.equal(store.snapshot().events.filter(e=>e.type==='ToolCalled').length,3)
const final=[...store.snapshot().events]
await Effect.runPromise(store.close)
store=await open(final)
await Effect.runPromise(store.wait)
assert.equal(deliveries.length,4)
assert.deepEqual([...store.snapshot().events], final, "settled journal replay is identical")
await Effect.runPromise(store.close)
// A write fences both earlier reads and later reads.
generated=0; deliveries.length=0; gates.clear(); scenario=['a','b','write-one','c','d','write-two','e']
store=await open()
await Effect.runPromise(runtime.send([requestTurn({text:'run',turnId:'mixed'})]))
await until(()=>deliveries.length===2)
gates.get('b')!(); await Bun.sleep(15); assert.deepEqual(deliveries,['a','b'])
gates.get('a')!(); await until(()=>deliveries.length===3)
assert.equal(deliveries[2],'write-one'); await Bun.sleep(15); assert.equal(deliveries.length,3)
gates.get('write-one')!(); await until(()=>deliveries.length===5)
gates.get('c')!(); gates.get('d')!(); await until(()=>deliveries.length===6)
gates.get('write-two')!(); await until(()=>deliveries.length===7)
gates.get('e')!(); await Effect.runPromise(store.wait)
assert.deepEqual(store.snapshot().events.filter(e=>e.type==='ToolReturned').map(e=>e.tool?.providerId),scenario)
await Effect.runPromise(store.close)

// Native cancellation owns every concurrent effect and prevents queued admissions.
generated=0; deliveries.length=0; stopped.length=0; gates.clear(); scenario=['a','b','c']
store=await open()
await Effect.runPromise(runtime.send([requestTurn({text:'run',turnId:'cancel',invocationRef:{method:'turn',id:'cancel'}})]))
await until(()=>deliveries.length===2)
await Effect.runPromise(runtime.send([abortRequested({ref:{method:'turn',id:'cancel'},reason:'stop'})]))
await Effect.runPromise(store.wait)
assert.deepEqual(deliveries,['a','b'])
assert.deepEqual(stopped.toSorted(),['a','b'])
assert.equal(store.snapshot().events.filter(e=>e.type==='TurnSettled' && e.outcome==='cancelled').length,1)
await Effect.runPromise(store.close)

// Spend reservations limit concurrent admission before the next effect starts.
generated=0; deliveries.length=0; gates.clear(); maxCalls=1
store=await open()
await Effect.runPromise(runtime.send([requestTurn({text:'run',turnId:'budget'})]))
await until(()=>deliveries.length===1)
await Effect.runPromise(runtime.send([{type:'BudgetUpdated',metric:'toolCalls',policy:{limit:1,onExhausted:'deny'}}]))
gates.get('a')!(); await Effect.runPromise(store.wait)
assert.deepEqual(deliveries,['a'])
assert.equal(store.snapshot().events.filter(e=>e.type==='ToolCalled' && e.counted).length,1)
await Effect.runPromise(store.close)


// Interactive permission requests keep a distinct native origin per call.
generated=0; deliveries.length=0; gates.clear(); maxCalls=10; permissionMode="ask"; scenario=['a','b']
store=await open()
await Effect.runPromise(runtime.send([requestTurn({text:'run',turnId:'permissions'})]))
await until(()=>deliveries.length===1)
await Bun.sleep(10)
assert.equal(asked.length, 1)
gates.get('a')!(); await until(()=>deliveries.length===2)
assert.equal(asked.length, 2)
assert.equal(new Set(asked).size, 2, "permission effects retain distinct origins")
gates.get('b')!(); await Effect.runPromise(store.wait)
assert.equal(store.snapshot().events.filter(e=>e.type==='ToolCalled' && e.counted).length,2)
await Effect.runPromise(store.close)

console.log('PASS bounded overlap, original order, mixed fences, all-call cancellation, permissions, spend admission, mid-batch recovery and settled replay')

}, 10_000)
