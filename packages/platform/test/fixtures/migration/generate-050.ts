import { Context, Deferred, Effect, Schema } from 'effect'
import { Database } from 'bun:sqlite'
import { type ActorRuntime, ScheduledWake, WatchdogEntry, watchdogKey, act, createActorStore, defineActor, durableAtom, durableMerkleAtom, effectAtom, effectKey } from '../../../../core/src/index'
import { bunJournal } from '../../../src/bun/index'
import { writeFileSync, existsSync } from 'node:fs'
const Event = Schema.Union([Schema.Struct({ type: Schema.Literal('Added'), text: Schema.String }), Schema.Struct({ type: Schema.Literal('Started') }), Schema.Struct({ type: Schema.Literal('Finished') })])
const Job = act({ name: 'migration-job', input: Schema.Struct({ messages: Schema.Array(Schema.String), token: Schema.String }), success: Schema.Int, failure: Schema.String })
const input = ['old Unicode 界é:' + 'accepted input '.repeat(240)]
const actor = defineActor('migration', Effect.sync(() => {
 const history = durableMerkleAtom({name:'migration.history', schema:Schema.Array(Schema.String), input:Event, initial:[], reduce:(state,event)=>event.type==='Added'?state.append([], [event.text]):state})
 const control = durableAtom({name:'migration.control',schema:Schema.Struct({started:Schema.Boolean,done:Schema.Boolean}),input:Event,initial:{started:false,done:false},reduce:(state,event)=>event.type==='Started'?{...state,started:true}:event.type==='Finished'?{...state,done:true}:state})
 let request: ReturnType<typeof Job.requestTree> | undefined
 return {schema:Event, atom:effectAtom(get=>{
  const messages=get(history), state=get(control)
  if(state.started&&!request) request=Job.requestTree({origin:1,input:{messages:messages.selectEach([],[],{start:0,end:messages.length([])}),token:"accepted-token:"+"z".repeat(2300)},onSettled:()=>[{type:'Finished'}]})
  return {view:{messages:messages.read([]),...state},events:{},acts:state.started&&!state.done?{job:request!}:{}}
 })}
}))
const filename=process.argv[2]
if(!filename) throw new Error('Supply a fresh SQLite filename')
if(existsSync(filename)) throw new Error('SQLite filename must be fresh')
const journal=bunJournal({filename,actor:'events',checkpointChunkBytes:127,eventInlineBytes:64})
await Effect.runPromise(journal.append(0,[{event:{type:'MessageReceived',body:{type:'Added',text:input[0]}},message:{id:'migration-message',from:{kind:'external',id:'sender'}}}]))
let acceptedInput: unknown
let send: ActorRuntime<typeof Event.Type>['send'] | undefined
const entered=Deferred.makeUnsafe<void>()
const keep=setInterval(()=>{},1000); const store=await Effect.runPromise(createActorStore({actor,journal,checkpoint:{mode:'manual'},actorContext:Context.pick(),attemptTimeoutMs:null,services:runtime=>{send=runtime.send;return Job.layer((input)=>Effect.sync(()=>{acceptedInput=input}).pipe(Effect.andThen(Deferred.succeed(entered,undefined)),Effect.andThen(Effect.never)))}}))

await Effect.runPromise(store.checkpoint)
await Effect.runPromise(send!([{type:'Started'}]))
await Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout(5000)))
const inputs=await Effect.runPromise(journal.readInputs)
const records=await Effect.runPromise(journal.read)
const db=new Database(filename)
const tables=db.query<{name:string;sql:string},[]>("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(table=>({...table,rows:db.query<Record<string, unknown>, []>(`SELECT * FROM ${table.name}`).all().map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value instanceof Uint8Array?{base64:Buffer.from(value).toString('base64')}:value])))}))
if(!tables.some(table=>table.name==='grove_nodes')||tables.some(table=>table.name==='grove_value_nodes')) throw new Error('Run the generator with the pinned 0.50 source')
const indexes=db.query<{name:string;sql:string},[]>("SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all()
const target={actor:'migration',instance:'upgrade',thread:'one'}
const dueAt=4102444800000
const wake=Schema.decodeSync(ScheduledWake)({id:'watchdog',target:{owner:'watchdog'},generation:7,dueAt,nextWakeAt:dueAt})
const watchdog=Schema.decodeSync(WatchdogEntry)({target,generation:4,progressCursor:records.length,attempts:2,consecutiveNoProgress:1,nextWakeAt:dueAt,status:'pending'})
const recovery={dueAt,wake,watchdog,key:watchdogKey(target),generation:7}
writeFileSync(filename+'.json',JSON.stringify({source:'d0191382c92c63d820a9e07c7e95b4d4ecbc0094',input,acceptedInput,inputs,records,recovery,ref:inputs[0]!.ref,effectKey:effectKey(inputs[0]!.ref),view:store.getState().view,tables,indexes})+'\n')
await Effect.runPromise(store.close)
await Effect.runPromise(journal.close)
db.close(); clearInterval(keep)
