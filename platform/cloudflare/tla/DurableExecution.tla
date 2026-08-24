------------------------ MODULE DurableExecution ------------------------
(* Cloudflare's execution law for one accepted unit of actor work.

   The handler stages the log append and its watchdog, crosses one event-loop
   turn so both become durable, then starts the immediate drive. A reset can
   erase staged writes, or cut a drive after the commit. The latter case keeps
   the durable watchdog, whose alarm starts a fresh drive. The alarm handler
   replaces its consumed alarm with another committed watchdog before it runs
   recovery, so a reset during recovery has the same shape.

   The model separates the event-loop commit from Promise microtasks. StageWork
   and StageWatchdog are buffered writes. CommitTurn is the macrotask boundary
   provided by scheduler.wait(0). StartImmediate cannot precede it.

   DurableExecutionNoTurn.cfg lets the body start over buffered writes and
   violates CoveredBeforeDrive. DurableExecutionNoWatchdog.cfg commits and
   starts without a watchdog; one reset violates OwedHasWake. *)

EXTENDS Naturals, TLC

CONSTANT MaxDeaths

ASSUME MaxDeaths \in Nat

VARIABLES stagedLog, stagedWatchdog, log, watchdog, drive, done, deaths

vars == <<stagedLog, stagedWatchdog, log, watchdog, drive, done, deaths>>

TypeOK ==
  /\ stagedLog \in BOOLEAN
  /\ stagedWatchdog \in BOOLEAN
  /\ log \in BOOLEAN
  /\ watchdog \in BOOLEAN
  /\ drive \in {"idle", "immediate", "alarm"}
  /\ done \in BOOLEAN
  /\ deaths \in 0..MaxDeaths

Init ==
  /\ stagedLog = FALSE
  /\ stagedWatchdog = FALSE
  /\ log = FALSE
  /\ watchdog = FALSE
  /\ drive = "idle"
  /\ done = FALSE
  /\ deaths = 0

(* The accepted input first exists only in the SQLite write buffer. *)
StageWork ==
  /\ ~stagedLog
  /\ ~log
  /\ stagedLog' = TRUE
  /\ UNCHANGED <<stagedWatchdog, log, watchdog, drive, done, deaths>>

(* The watchdog is staged before the body can begin. *)
StageWatchdog ==
  /\ stagedLog
  /\ ~stagedWatchdog
  /\ stagedWatchdog' = TRUE
  /\ UNCHANGED <<stagedLog, log, watchdog, drive, done, deaths>>

(* One macrotask turn commits the append and alarm together. *)
CommitTurn ==
  /\ stagedLog
  /\ stagedWatchdog
  /\ log' = TRUE
  /\ watchdog' = TRUE
  /\ stagedLog' = FALSE
  /\ stagedWatchdog' = FALSE
  /\ UNCHANGED <<drive, done, deaths>>

(* A reset before the commit loses buffered writes and returns no acceptance. *)
ResetBuffered ==
  /\ stagedLog
  /\ ~log
  /\ stagedLog' = FALSE
  /\ stagedWatchdog' = FALSE
  /\ UNCHANGED <<log, watchdog, drive, done, deaths>>

StartImmediate ==
  /\ log
  /\ watchdog
  /\ ~done
  /\ drive = "idle"
  /\ drive' = "immediate"
  /\ UNCHANGED <<stagedLog, stagedWatchdog, log, watchdog, done, deaths>>

(* Firing consumes the old alarm and commits its replacement before recovery. *)
Fire ==
  /\ log
  /\ watchdog
  /\ ~done
  /\ drive = "idle"
  /\ drive' = "alarm"
  /\ watchdog' = TRUE
  /\ UNCHANGED <<stagedLog, stagedWatchdog, log, done, deaths>>

Complete ==
  /\ drive # "idle"
  /\ ~done
  /\ done' = TRUE
  /\ drive' = "idle"
  /\ UNCHANGED <<stagedLog, stagedWatchdog, log, watchdog, deaths>>

ClearWatchdog ==
  /\ done
  /\ drive = "idle"
  /\ watchdog
  /\ watchdog' = FALSE
  /\ UNCHANGED <<stagedLog, stagedWatchdog, log, drive, done, deaths>>

(* Eviction, CPU termination, and a swallowed drive failure have no terminal. *)
Die ==
  /\ drive # "idle"
  /\ ~done
  /\ deaths < MaxDeaths
  /\ drive' = "idle"
  /\ deaths' = deaths + 1
  /\ UNCHANGED <<stagedLog, stagedWatchdog, log, watchdog, done>>

Next == StageWork \/ StageWatchdog \/ CommitTurn \/ ResetBuffered \/
        StartImmediate \/ Fire \/ Complete \/ ClearWatchdog \/ Die

Spec == Init /\ [][Next]_vars

LiveSpec ==
  /\ Spec
  /\ WF_vars(StageWatchdog)
  /\ WF_vars(CommitTurn)
  /\ WF_vars(StartImmediate)
  /\ WF_vars(Fire)
  /\ WF_vars(Complete)
  /\ WF_vars(ClearWatchdog)

(* The body never runs over writes a hard kill could still erase. *)
CoveredBeforeDrive == drive # "idle" => log /\ watchdog

(* Every durable, unfinished obligation has a live drive or durable wake. *)
OwedHasWake == log /\ ~done => drive # "idle" \/ watchdog

EventuallyDone == log ~> done

(* Defect: a Promise continuation begins work before the next turn commits. *)
StartUncommitted ==
  /\ stagedLog
  /\ stagedWatchdog
  /\ ~log
  /\ drive' = "immediate"
  /\ UNCHANGED <<stagedLog, stagedWatchdog, log, watchdog, done, deaths>>

NextNoTurn == StageWork \/ StageWatchdog \/ StartUncommitted
SpecNoTurn == Init /\ [][NextNoTurn]_vars

(* Defect: the log commits and the drive starts without a watchdog. *)
CommitUnarmed ==
  /\ stagedLog
  /\ ~log
  /\ log' = TRUE
  /\ stagedLog' = FALSE
  /\ stagedWatchdog' = FALSE
  /\ watchdog' = FALSE
  /\ drive' = "immediate"
  /\ UNCHANGED <<done, deaths>>

NextNoWatchdog == StageWork \/ CommitUnarmed \/ Die
SpecNoWatchdog == Init /\ [][NextNoWatchdog]_vars

=============================================================================
