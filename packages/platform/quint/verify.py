#!/usr/bin/env python3
"""Check recovery models and require each named negative variant to fail."""

import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile


root = Path(__file__).resolve().parent
output = Path(tempfile.mkdtemp(prefix="tardigrade-recovery-", dir="/tmp"))
java = os.environ.get("TLA_JAVA", "/opt/homebrew/opt/openjdk/bin/java")
tlc = Path(os.environ.get("TLA2TOOLS_JAR", str(Path.home() / ".local/opt/tla2tools/tla2tools.jar")))
apalache = Path(os.environ.get("APALACHE_JAR", str(Path.home() / ".quint/apalache-dist-0.56.1/apalache/lib/apalache.jar")))
quint = shutil.which("quint")
if not quint or not tlc.is_file() or not apalache.is_file():
    raise SystemExit("Install Quint and supply TLA2TOOLS_JAR and APALACHE_JAR for the local checkers")
environment = {**os.environ, "PATH": str(Path(java).parent) + os.pathsep + os.environ["PATH"]}
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    endpoint = os.environ.get("APALACHE_ENDPOINT", f"localhost:{listener.getsockname()[1]}")


def check(model, initializer, invariant="", temporal="", expected=0):
    directory = output / f"{model}-{initializer}-{invariant or temporal}"
    directory.mkdir()
    compile_command = [quint, "compile", str(root / f"{model}.qnt"), "--target", "tlaplus", "--init", initializer, "--server-endpoint", endpoint]
    config = ["INIT q_init", "NEXT q_step"]
    if invariant:
        compile_command += ["--invariant", invariant]
        config += ["INVARIANT q_inv"]
    if temporal:
        compile_command += ["--temporal", temporal]
        config += ["PROPERTY q_temporalProps"]
    compiled = subprocess.run(compile_command, cwd=output, env=environment, capture_output=True, text=True)
    (directory / "compile.log").write_text(compiled.stderr)
    if compiled.returncode:
        raise RuntimeError(compiled.stdout + compiled.stderr)
    (directory / f"{model}.tla").write_text(compiled.stdout)
    (directory / f"{model}.cfg").write_text("\n".join(config) + "\n")
    checked = subprocess.run([
        java, "-XX:+UseParallelGC", "-Xmx2G", "-cp", str(tlc) + os.pathsep + str(apalache),
        "tlc2.TLC", "-deadlock", "-workers", "2", "-metadir", str(directory / "states"), f"{model}.tla",
    ], cwd=directory, capture_output=True, text=True)
    log = checked.stdout + checked.stderr
    (directory / "check.log").write_text(log)
    if checked.returncode != expected:
        raise RuntimeError(f"{model}/{initializer}: expected TLC exit {expected}, got {checked.returncode}\n{log}")
    violation = "Invariant q_inv is violated" if invariant else "Temporal property q_temporalProps was violated"
    if expected and violation not in log:
        raise RuntimeError(f"{model}/{initializer}: expected property violation was not reported\n{log}")
    counts = re.findall(r"([\d,]+) states generated, ([\d,]+) distinct states found", log)
    size = counts[-1][1] if counts else "?"
    result = "PASS" if expected == 0 else "COUNTEREXAMPLE"
    print(f"{result:14} {model:18} {initializer:26} {invariant or temporal:24} states={size}", flush=True)


print(f"Checker artifacts: {output}", flush=True)
check("watchdog", "init", "invariant", "eventualSettlement")
check("recoveryBudget", "init", "invariant", "eventualStop")
check("invocationReplay", "init", "invariant", "eventualOutcome")
check("invocationReplay", "initUnsafe", "invariant", "eventualOutcome")
check("promiseLifecycle", "init", "invariant", "eventualSettlement,terminalStable")

for initializer in ["initWithoutAdmissionWake", "initWithoutRenewal", "initWithoutRetry", "initStaleClear", "initFiniteRetry"]:
    check("watchdog", initializer, "wakeCoverage", expected=12)
    check("watchdog", initializer, temporal="eventualSettlement", expected=13)
for initializer in ["initPostcharge", "initVolatileBudget", "initResetTotal"]:
    check("recoveryBudget", initializer, "boundedAttempts", expected=12)
    check("recoveryBudget", initializer, temporal="eventualStop", expected=13)
check("recoveryBudget", "initRetryTerminal", "terminalStops", expected=12)
check("recoveryBudget", "initExtendLiveDeadline", temporal="eventualStop", expected=13)
for initializer in ["initFreshIdentity", "initWithoutDeduplication", "initReplayUnsafe"]:
    check("invocationReplay", initializer, "oneLogicalExecution", expected=12)
check("invocationReplay", "initVolatileReply", "replyDurability", expected=12)
check("invocationReplay", "initVolatileDependency", "dependencyRecoverable", expected=12)
check("invocationReplay", "initVolatileDependency", temporal="eventualOutcome", expected=13)
for initializer in ["initVolatileReply", "initBlindSubscribe"]:
    check("invocationReplay", initializer, temporal="eventualOutcome", expected=13)
for initializer, invariant in [
    ("initUnsupervised", "fibreExitAccounted"), ("initVolatileResult", "completionDurable"),
    ("initEarlyPark", "pendingCoverage"), ("initSharedClear", "pendingCoverage"),
    ("initRemotePolling", "noRemoteBurn"), ("initResetDeadline", "deadlineStable"),
    ("initOverwriteTerminal", "firstDecisionWins"),
]:
    check("promiseLifecycle", initializer, invariant, expected=12)
check("promiseLifecycle", "initSharedClear", temporal="eventualSettlement", expected=13)
check("promiseLifecycle", "initOverwriteTerminal", temporal="terminalStable", expected=12)
print("All positive checks and expected counterexamples passed.", flush=True)
